/**
 * IX Bid Adapter (ORTB Converter Integration)
 */
import { ortbConverter } from '../ortbConverter/converter.js';
import { BANNER, VIDEO, NATIVE } from '../../src/mediaTypes.js';
import { deepAccess, deepClone, logWarn, deepSetValue, safeJSONParse, isFn, isArray } from '../../src/utils.js';
import { Renderer } from '../../src/Renderer.js';
import { getGptSlotInfoForAdUnitCode } from '../gptUtils/gptUtils.js';
import { INSTREAM, OUTSTREAM } from '../../src/video.js';
import { getStorageManager } from '../../src/storageManager.js';
import { config } from '../../src/config.js';

const SECURE_BID_URL = 'https://htlb.casalemedia.com/openrtb/pbjs';
const SUPPORTED_AD_TYPES = [BANNER, VIDEO, NATIVE];
const PRICE_TO_DOLLAR_FACTOR = { JPY: 1 };
const CENT_TO_DOLLAR_FACTOR = 100;
const BANNER_TIME_TO_LIVE = 300;
const VIDEO_TIME_TO_LIVE = 3600;
const NATIVE_TIME_TO_LIVE = 3600;
const MEDIA_TYPES = { Banner: 1, Video: 2, Audio: 3, Native: 4 };
const MAX_EID_SOURCES = 50;
const BIDDER_CODE = 'ix';
const FLOOR_SOURCE = { PBJS: 'p', IX: 'x' };
const defaultVideoPlacementBids = new WeakSet();
const SOURCE_RTI_MAPPING = {
  'liveramp.com': 'idl',
  'netid.de': 'NETID',
  'neustar.biz': 'fabrickId',
  'zeotap.com': 'zeotapIdPlus',
  'uidapi.com': 'UID2',
  'adserver.org': 'TDID'
};

export const LOCAL_STORAGE_FEATURE_TOGGLES_KEY = `${BIDDER_CODE}_features`;
export const storage = getStorageManager({ bidderCode: BIDDER_CODE });

/**
 * Whether an Exchange ID is configured (string/number with numeric value).
 */
export function isExchangeIdConfigured() {
  const exchangeId = config.getConfig('exchangeId');
  if (typeof exchangeId === 'number' && isFinite(exchangeId)) return true;
  if (typeof exchangeId === 'string' && exchangeId.trim() !== '' && isFinite(Number(exchangeId))) return true;
  return false;
}

export const converter = ortbConverter({
  context: {
    netRevenue: true,
  },

  /**
   * Request stage: runs once with the array of imps. Ensures regs/consent, page,
   * schain, and common request level ext fields are set.
   */
  request(buildRequest, imps, bidderRequest, context) {
    const ctx = { ...context, bidderRequest };
    const request = buildRequest(imps, bidderRequest, ctx);

    // bidderRequestId (as in Legacy) instead of a new UUID, so the request can be traced in Prebid events and analytics
    if (bidderRequest?.bidderRequestId != null) request.id = String(bidderRequest.bidderRequestId);
    request.at = 1;
    request.ext = request.ext || {};
    request.ext.source = 'prebid';
    request.ext.ixdiag = {};

    return request;
  },
  /**
   * Imp stage: runs once per valid bidRequest. Ensures placement, size,
   * floors, siteID, and other imp level ext fields are set.
   */
  imp(buildImp, bidRequest, context) {
    let imp = buildImp(bidRequest, context);

    // Ensure we always provide an id so it isn't filtered out by downstream logic
    if (!imp || typeof imp !== 'object') imp = {};
    if (!Object.prototype.hasOwnProperty.call(imp, 'id') && bidRequest?.bidId) {
      imp.id = bidRequest.bidId;
    }

    // VIDEO: placement and w/h
    if (bidRequest.mediaTypes?.hasOwnProperty(VIDEO)) {
      let videoParams = Object.assign({}, bidRequest.mediaTypes[VIDEO], bidRequest.params?.video);

      // placement
      if (videoParams && !(imp.video?.hasOwnProperty && imp.video.hasOwnProperty('placement'))) {
        if (!imp.video) imp.video = {};
        const vidContext = videoParams.context;
        if (vidContext === INSTREAM) {
          imp.video.placement = 1; // instream
        } else if (vidContext === OUTSTREAM) {
          if (deepAccess(videoParams, 'playerConfig.floatOnScroll')) {
            imp.video.placement = 5; // in article/float on scroll
          } else {
            imp.video.placement = 3; // outstream
            defaultVideoPlacementBids.add(bidRequest); // used by diagnostics (ixdiag.vpd)
          }
        }
      }

      // Legacy falls back to params.size when the ad unit has no player size
      const size = getParamsSize(bidRequest);
      if (imp.video && imp.video.w == null && size) {
        imp.video.w = size[0];
        imp.video.h = size[1];
      }

      // params.video is copied as is, so a malformed plcmt is removed (Legacy verifyVideoPlcmt)
      if (imp.video && hasOwn(imp.video, 'plcmt') &&
        (!Number.isInteger(imp.video.plcmt) || imp.video.plcmt < 1 || imp.video.plcmt > 4)) {
        logWarn(`IX Bid Adapter: video.plcmt [${imp.video.plcmt}] must be an integer between 1-4 inclusive`);
        delete imp.video.plcmt;
      }
    }

    // siteID: the media specific params.<mediaType>.siteId, otherwise params.siteId
    const params = bidRequest.params || {};
    const mediaSiteId = SUPPORTED_AD_TYPES
      .map((type) => imp[type] && params[type]?.siteId)
      .find((id) => id != null && id !== '' && !isNaN(Number(id)));
    const siteId = mediaSiteId != null ? mediaSiteId : params.siteId;
    if (siteId) deepSetValue(imp, 'ext.siteID', String(siteId));

    applyFloors(imp, bidRequest);

    // Imp ext.sid (IX per adunit ID); ext.tid and the rest of ortb2Imp.ext come from the converter
    if (bidRequest.params?.hasOwnProperty('id')) {
      deepSetValue(imp, 'ext.sid', String(bidRequest.params.id));
    }

    const dfpAdUnitCode = deepAccess(bidRequest, 'ortb2Imp.ext.data.adserver.adslot');
    if (dfpAdUnitCode) deepSetValue(imp, 'ext.dfp_ad_unit_code', dfpAdUnitCode);

    // externalID if globally configured
    if (isExchangeIdConfigured() && deepAccess(bidRequest, 'params.externalId')) {
      deepSetValue(imp, 'ext.externalID', bidRequest.params.externalId);
    }

    setDisplayManager(imp, bidRequest);

    return imp;
  },
  /**
   * BidResponse stage: normalize currency/CPM, native ADM, attach renderer,
   * sizes, ttl, meta, and various pass through fields.
   */
  bidResponse(buildBidResponse, bid, context) {
    logIXServerError(deepAccess(context, 'ortbResponse.ext.errors'), deepAccess(context, 'ortbResponse.ext.nbr'))

    const currency = deepAccess(context, 'ortbResponse.cur') || 'USD';
    bid.currency = currency;

    const parsedAdm = (typeof bid?.adm === 'string' && bid.adm.trim().startsWith('{')) ? safeJSONParse(bid.adm) : null;
    const nativeInner = parsedAdm && parsedAdm.native;

    // Without a known mtype the converter would drop the bid; infer it like Legacy parseBid():
    // a VAST URL means video, the IX {"native": {...}} wrapper means native, anything else is banner.
    if (![MEDIA_TYPES.Banner, MEDIA_TYPES.Video, MEDIA_TYPES.Native].includes(bid?.mtype)) {
      const mtype = bid?.ext?.vasturl ? MEDIA_TYPES.Video : (nativeInner != null ? MEDIA_TYPES.Native : MEDIA_TYPES.Banner);
      bid = { ...bid, mtype };
    }

    // Native normalization: unwrap the IX {"native": {...}} adm into the inner payload
    if (bid.mtype === MEDIA_TYPES.Native && nativeInner != null) {
      bid = { ...bid, adm: typeof nativeInner === 'string' ? nativeInner : JSON.stringify(nativeInner) };
    }

    const bidResponse = buildBidResponse(bid, context);

    const normalizedCpm = Object.prototype.hasOwnProperty.call(PRICE_TO_DOLLAR_FACTOR, currency)
      ? bid.price / PRICE_TO_DOLLAR_FACTOR[currency]
      : bid.price / CENT_TO_DOLLAR_FACTOR;

    bidResponse.currency = currency;
    bidResponse.cpm = normalizedCpm;

    if (typeof bid.exp === 'number') bidResponse.ttl = bid.exp;

    // Video specific fields
    if (bidResponse.mediaType === VIDEO) {
      // Prefer server reported size if present, else fall back to the original imp size
      const imps = deepAccess(context, 'ortbRequest.imp', []);
      const imp = Array.isArray(imps) ? imps.find((i) => i && i.id === bid.impid) : null;
      const vw = bid.w ?? deepAccess(imp, 'video.w');
      const vh = bid.h ?? deepAccess(imp, 'video.h');
      if (vw != null) bidResponse.playerWidth = vw;
      if (vh != null) bidResponse.playerHeight = vh;

      // Legacy: an exchange VAST URL wins; inline VAST (adm) is only used without one
      if (bid.ext?.vasturl) delete bidResponse.vastXml;
      else if (typeof bid.adm === 'string' && bid.adm.length) bidResponse.vastXml = bid.adm;

      // Legacy copies the ad unit mediaTypes onto video bids (read by outstream players)
      if (context.bidRequest?.mediaTypes) bidResponse.mediaTypes = context.bidRequest.mediaTypes;

      // Outstream renderer: attach IX renderer if preferred and URL provided
      if (isIndexRendererPreferred(context.bidRequest)) {
        const rendererUrl = deepAccess(context, 'ortbResponse.ext.videoplayerurl');
        if (rendererUrl) bidResponse.renderer = createRenderer(bid.id, rendererUrl);
      }

      // VAST URL passthrough
      if (bid.ext?.vasturl) bidResponse.vastUrl = bid.ext.vasturl;
    }

    // Legacy reports native bids as 1x1 when the exchange sends no size
    if (bidResponse.mediaType === NATIVE) {
      bidResponse.width = bid.w ? bid.w : 1;
      bidResponse.height = bid.h ? bid.h : 1;
    }

    bidResponse.creativeId = Object.prototype.hasOwnProperty.call(bid, 'crid') ? bid.crid : '-';

    if (bid.mtype === MEDIA_TYPES.Video && bidResponse.ttl === undefined) {
      bidResponse.ttl = VIDEO_TIME_TO_LIVE;
    } else if (bid.mtype === MEDIA_TYPES.Native && bidResponse.ttl === undefined) {
      bidResponse.ttl = NATIVE_TIME_TO_LIVE;
    } else if (bid.mtype === MEDIA_TYPES.Banner && bidResponse.ttl === undefined) {
      bidResponse.ttl = BANNER_TIME_TO_LIVE;
    }

    if (!deepAccess(bidResponse, 'meta', false)) bidResponse.meta = {};
    bidResponse.meta.networkId = deepAccess(bid, 'ext.dspid');
    bidResponse.meta.brandId = deepAccess(bid, 'ext.advbrandid');
    bidResponse.meta.brandName = deepAccess(bid, 'ext.advbrand');

    if (deepAccess(bid, 'ext.dsa', false)) bidResponse.meta.dsa = bid.ext.dsa;

    if (!bidResponse.dealId && deepAccess(bid, 'ext.dealid')) {
      bidResponse.dealId = deepAccess(bid, 'ext.dealid');
    }

    if (deepAccess(bid, 'ext.ibv')) {
      if (bidResponse.ext === undefined) bidResponse.ext = {};
      bidResponse.ext.ibv = bid.ext.ibv;
    }

    return bidResponse;
  },

  /**
   *   Overrides Stage: called once per impression for the corresponding media type.
   *   Allow for (a) merge bidder params into mediaTypes before the base builder
   *   runs, and (b) append IX specific fields after the base builder runs.
   */
  overrides: {
    imp: {
      /**
       * Banner override: merge params.banner into mediaTypes.banner.
       */
      banner(orig, imp, bidRequest, context) {
        if (bidRequest.mediaTypes[BANNER]) {
          const banner = Object.assign({}, deepClone(bidRequest.mediaTypes[BANNER]), deepClone(bidRequest.params?.banner));
          bidRequest = { ...bidRequest, mediaTypes: { [BANNER]: banner } };
        }
        orig(imp, bidRequest, context);
      },

      /**
       * Video override: merge params.video into mediaTypes.video; params.video wins.
       */
      video(orig, imp, bidRequest, context) {
        const paramsVideo = deepClone(bidRequest.params?.video);
        if (bidRequest.mediaTypes[VIDEO]) {
          const video = Object.assign({}, deepClone(bidRequest.mediaTypes[VIDEO]), deepClone(paramsVideo));
          bidRequest = { ...bidRequest, mediaTypes: { [VIDEO]: video } };
        }

        orig(imp, bidRequest, context);

        if (imp.video && paramsVideo && typeof paramsVideo === 'object') {
          Object.keys(paramsVideo).forEach((key) => { imp.video[key] = deepClone(paramsVideo[key]); });
        }
      },

      /**
       * Native override: normalize nativeOrtbRequest and merge params.native.
       */
      native(orig, imp, bidRequest, context) {
        if (bidRequest.nativeOrtbRequest) {
          const req = { ...bidRequest.nativeOrtbRequest };
          req.eventtrackers = [{ event: 1, methods: [1, 2] }];
          req.privacy = 1;
          req.ver = '1.2';
          bidRequest.nativeOrtbRequest = req;
        }

        if (bidRequest.mediaTypes[NATIVE]) {
          const native = Object.assign({}, deepClone(bidRequest.mediaTypes[NATIVE]), deepClone(bidRequest.params?.native));
          bidRequest = { ...bidRequest, mediaTypes: { [NATIVE]: native } };
        }
        orig(imp, bidRequest, context);
      },
    },
  },
});

/**
 * Convert the ORTB response to Prebid bids using the converter and store server provided feature toggles.
 */
export function interpretResponseORTBConverter(serverResponse, bidderRequest) {
  if (!serverResponse.body) return [];

  FEATURE_TOGGLES.setFeatureToggles(serverResponse);

  // Pass PAAPI configs back to Prebid if present
  const resp = serverResponse.body;
  let fledgeAuctionConfigs = deepAccess(resp, 'ext.protectedAudienceAuctionConfigs')
  let bids = [];
  try {
    bids = converter.fromORTB({
      response: serverResponse.body,
      request: bidderRequest.data,
      bidRequests: bidderRequest.validBidRequests,
    });
  } catch (e) {
    logWarn('IX Bid Adapter: error converting ORTB response', e);
    bids = [];
  }

  if (Array.isArray(fledgeAuctionConfigs) && fledgeAuctionConfigs.length > 0) {
    return { bids, paapi: fledgeAuctionConfigs };
  }
  return bids;
}

/**
 * The [w, h] pair from params.size, if valid.
 */
function getParamsSize(bidRequest) {
  const size = deepAccess(bidRequest, 'params.size');
  if (Array.isArray(size) && size.length === 2 && Number.isFinite(size[0]) && Number.isFinite(size[1])) {
    return size;
  }
  return null;
}

function getBannerSizes(bidRequest) {
  const sizes = deepAccess(bidRequest, 'mediaTypes.banner.sizes', []);
  if (!Array.isArray(sizes)) return [];
  if (sizes.length === 2 && Number.isFinite(sizes[0]) && Number.isFinite(sizes[1])) return [sizes];
  return sizes.filter((size) => Array.isArray(size) && size.length === 2 && Number.isFinite(size[0]) && Number.isFinite(size[1]));
}

function sameSize(a, b) {
  return Array.isArray(a) && Array.isArray(b) && a[0] === b[0] && a[1] === b[1];
}

function getBannerSiteID(bidRequest) {
  const mediaSiteID = deepAccess(bidRequest, 'params.banner.siteId');
  const siteID = mediaSiteID != null ? mediaSiteID : deepAccess(bidRequest, 'params.siteId');
  return siteID != null ? String(siteID) : null;
}

/**
 * Call the bid's getFloor() like Legacy does: a throwing floor function logs a
 * warning and the request is still built (without a module floor).
 */
function getFloorSafely(bidRequest, options) {
  if (!isFn(bidRequest?.getFloor)) return null;
  try {
    return bidRequest.getFloor(options);
  } catch (err) {
    logWarn('priceFloors module call getFloor failed, error : ', err);
    return null;
  }
}

/**
 * Make sure a banner format, video or native object carries its own floor.
 * A floor set by the priceFloors module processors is kept. Prebid leaves one out when it
 * equals imp.bidfloor, and never uses params.bidFloor, so those gaps are filled here:
 * the module floor (in imp.bidfloorcur) first, then params.bidFloor / params.bidFloorCur.
 */
function fillFloor(target, imp, bidRequest, mediaType, size) {
  const ext = { ...(target.ext || {}) };
  if (Number.isFinite(ext.bidfloor)) {
    target.ext = { ...ext, fl: FLOOR_SOURCE.PBJS };
    return;
  }
  // A non finite floor (e.g. NaN, sent as null) is treated as missing
  delete ext.bidfloor;
  delete ext.bidfloorcur;
  if (Object.keys(ext).length > 0) target.ext = ext;
  else delete target.ext;
  const options = { mediaType, size };
  const currency = imp.bidfloorcur || config.getConfig('currency.adServerCurrency');
  if (currency) options.currency = currency;
  const moduleFloor = getFloorSafely(bidRequest, options);
  const params = bidRequest?.params;
  let floor = null;
  if (Number.isFinite(moduleFloor?.floor)) {
    floor = { bidfloor: moduleFloor.floor, bidfloorcur: moduleFloor.currency, fl: FLOOR_SOURCE.PBJS };
  } else if (params?.bidFloor && params?.bidFloorCur && Number.isFinite(Number(params.bidFloor))) {
    floor = { bidfloor: Number(params.bidFloor), bidfloorcur: params.bidFloorCur, fl: FLOOR_SOURCE.IX };
  }
  if (floor) target.ext = { ...ext, ...floor };
}

/**
 * Fill the per format, video and native floors of an imp (see fillFloor).
 * A video part Legacy would drop is not priced.
 */
export function applyFloors(imp, bidRequest) {
  (imp.banner?.format || []).forEach((format) => {
    if (format.w != null && format.h != null) fillFloor(format, imp, bidRequest, BANNER, [format.w, format.h]);
  });
  if (imp.video && isLegacyVideoValid(bidRequest)) {
    const size = (imp.video.w && imp.video.h) ? [imp.video.w, imp.video.h] : undefined;
    fillFloor(imp.video, imp, bidRequest, VIDEO, size);
  }
  if (imp.native) fillFloor(imp.native, imp, bidRequest, NATIVE);
}

/**
 * imp.bidfloor comes from the priceFloors module when it set one; otherwise it is the
 * lowest floor of the imp's parts.
 */
function setImpFloor(imp) {
  if (Number.isFinite(imp.bidfloor)) return;
  delete imp.bidfloor;
  delete imp.bidfloorcur;
  const exts = [imp.banner?.ext, ...(imp.banner?.format || []).map((f) => f?.ext), imp.video?.ext, imp.native?.ext]
    .filter((ext) => Number.isFinite(ext?.bidfloor));
  if (exts.length === 0) return;
  const lowest = exts.reduce((a, b) => (b.bidfloor < a.bidfloor ? b : a));
  imp.bidfloor = lowest.bidfloor;
  if (lowest.bidfloorcur) imp.bidfloorcur = lowest.bidfloorcur;
}

function buildBannerFormat(bidRequest, size, sourceImp) {
  const sourceFormat = (sourceImp?.banner?.format || []).find((candidate) => sameSize([candidate?.w, candidate?.h], size));
  const format = { ...(sourceFormat || {}), w: size[0], h: size[1] };
  const ext = { ...(sourceFormat?.ext || {}) };
  delete format.ext;
  delete ext.sid;
  delete ext.externalID;

  const siteID = getBannerSiteID(bidRequest);
  if (siteID != null) ext.siteID = siteID;
  if (Object.keys(ext).length > 0) format.ext = ext;
  return format;
}

const LEGACY_REQUIRED_VIDEO_PARAMS = ['mimes', 'minduration', 'maxduration'];

function hasOwn(obj, key) {
  return !!obj && typeof obj === 'object' && Object.prototype.hasOwnProperty.call(obj, key);
}

function getFirstSize(sizes) {
  if (!Array.isArray(sizes) || sizes.length === 0) return null;
  if (Array.isArray(sizes[0])) return sizes[0].length === 2 ? sizes[0] : null;
  return sizes.length === 2 ? sizes : null;
}

/**
 * Mirror Legacy bidToVideoImp(): a video part is only sent when the required
 * params are present (mediaTypes.video or params.video), minduration does not
 * exceed maxduration, and a player size can be resolved. Legacy drops the video
 * part otherwise (banner/native parts of the same bid are still sent).
 */
export function isLegacyVideoValid(bidRequest) {
  const adUnitVideo = deepAccess(bidRequest, 'mediaTypes.video');
  const paramsVideo = deepAccess(bidRequest, 'params.video');
  if (LEGACY_REQUIRED_VIDEO_PARAMS.some((key) => !hasOwn(adUnitVideo, key) && !hasOwn(paramsVideo, key))) return false;
  if (!['protocol', 'protocols'].some((key) => hasOwn(adUnitVideo, key) || hasOwn(paramsVideo, key))) return false;

  // Legacy builds imp.video from params.video first, then fills gaps from mediaTypes.video.
  const pick = (key) => (hasOwn(paramsVideo, key) ? paramsVideo[key] : adUnitVideo?.[key]);
  if (pick('minduration') > pick('maxduration')) return false;
  if (pick('w') && pick('h')) return true;
  return !!(getFirstSize(pick('playerSize')) || getFirstSize(deepAccess(bidRequest, 'params.size')));
}

/**
 * Build the one consolidated Banner imp for an ad unit (Legacy bannerImps[adUnitCode]).
 */
function buildLegacyBannerImp(entries, paapiEnabled) {
  const first = entries[0];
  const configured = [];
  const formats = [];
  let anchor = null;

  entries.forEach(({ bidRequest, imp }) => {
    const size = getParamsSize(bidRequest);
    // Legacy ignores an IX entry whose params.size is not one of the ad unit sizes
    if (!size || !getBannerSizes(bidRequest).some((adUnitSize) => sameSize(adUnitSize, size))) return;
    // Legacy takes the imp id from the first entry that has a configured size
    if (!anchor) anchor = { bidRequest, imp };
    configured.push(size);
    formats.push(buildBannerFormat(bidRequest, size, imp));
  });

  // Legacy adds ad unit banner sizes that have no explicit IX size entry
  // after the IX configured sizes. Those missing sizes inherit the first IX
  // entry's site/floor configuration.
  getBannerSizes(first.bidRequest).forEach((size) => {
    if (configured.some((configuredSize) => sameSize(configuredSize, size))) return;
    formats.push(buildBannerFormat(first.bidRequest, size, first.imp));
  });

  anchor = anchor || first;
  const consolidated = {
    ...anchor.imp,
    banner: {
      ...(anchor.imp.banner || {}),
      format: formats,
    },
  };
  delete consolidated.video;
  delete consolidated.native;
  delete consolidated.audio;

  // Legacy banner consolidation does not carry a single imp level siteID;
  // each format retains the siteID belonging to its IX size entry.
  if (consolidated.ext) {
    consolidated.ext = { ...consolidated.ext };
    delete consolidated.ext.siteID;
    delete consolidated.ext.sid;
  }

  // Ad unit metadata, replayed with Legacy's per field rules (createBannerImps runs once per
  // IX entry; addImpressions then builds imp.ext from the result):
  // - gpid, tid, dfp_ad_unit_code, banner.pos: overwritten by every entry, even with "missing";
  // - sid (params.id) and ext.data (ortb2Imp.ext.data): only overwritten when present;
  // - ae / paapi: only tracked when PAAPI is enabled, sent only when ae === 1;
  // - externalID: from the first sized entry (the anchor imp, kept above).
  const meta = {};
  entries.forEach(({ bidRequest }) => {
    meta.gpid = deepAccess(bidRequest, 'ortb2Imp.ext.gpid');
    meta.tid = deepAccess(bidRequest, 'ortb2Imp.ext.tid');
    meta.dfp = deepAccess(bidRequest, 'ortb2Imp.ext.data.adserver.adslot');
    meta.pos = deepAccess(bidRequest, 'mediaTypes.banner.pos');
    const sid = deepAccess(bidRequest, 'params.id');
    if (sid && (typeof sid === 'string' || typeof sid === 'number')) meta.sid = String(sid);
    const data = deepAccess(bidRequest, 'ortb2Imp.ext.data');
    if (data) meta.data = data;
    if (paapiEnabled) {
      const paapi = deepAccess(bidRequest, 'ortb2Imp.ext.paapi');
      if (paapi) meta.paapi = paapi;
      const ae = deepAccess(bidRequest, 'ortb2Imp.ext.ae');
      if (ae && Number.isInteger(ae)) meta.ae = ae;
    }
  });

  const ext = { ...(consolidated.ext || {}) };
  ['gpid', 'tid', 'dfp_ad_unit_code', 'sid', 'data', 'ae', 'paapi'].forEach((key) => delete ext[key]);
  if (meta.dfp) ext.dfp_ad_unit_code = meta.dfp;
  if (meta.gpid) ext.gpid = meta.gpid;
  if (meta.tid) ext.tid = meta.tid;
  if (meta.sid) ext.sid = meta.sid;
  if (Number(meta.ae) === 1) {
    ext.ae = 1;
    if (meta.paapi) ext.paapi = meta.paapi;
  }
  if (meta.data) ext.data = meta.data;
  if (Object.keys(ext).length > 0) consolidated.ext = ext;
  else delete consolidated.ext;

  delete consolidated.banner.pos;
  if (Number.isInteger(meta.pos)) consolidated.banner.pos = meta.pos;

  return consolidated;
}

/**
 * Build the imps Legacy sends for one ad unit (all IX entries sharing an adUnitCode):
 * - Banner: one consolidated imp (see buildLegacyBannerImp);
 * - Video: only the LAST IX entry with a valid video part (Legacy videoImps[adUnitCode]);
 * - Native: only the LAST IX entry with a native part (Legacy nativeImps[adUnitCode]);
 * - a Video/Native part whose bid id matches an imp already built is merged into it
 *   (Legacy addImpressions), otherwise it becomes its own imp.
 */
function buildLegacyAdUnitImps(entries, paapiEnabled) {
  const bannerEntries = entries.filter(({ imp }) => imp.banner);
  const lastWith = (part) => {
    for (let i = entries.length - 1; i >= 0; i--) {
      if (entries[i].imp[part]) return entries[i];
    }
    return null;
  };

  const out = [];
  const bannerImp = bannerEntries.length ? buildLegacyBannerImp(bannerEntries, paapiEnabled) : null;
  if (bannerImp) out.push(bannerImp);
  const mergedSources = [];

  [['video', lastWith('video')], ['native', lastWith('native')]].forEach(([part, entry]) => {
    if (!entry) return;
    const target = out.find((imp) => imp.id === entry.imp.id);
    if (target) {
      target[part] = entry.imp[part];
      if (target === bannerImp) mergedSources.push(entry.imp);
      return;
    }
    const imp = { ...entry.imp, ext: { ...(entry.imp.ext || {}) } };
    delete imp.banner;
    delete imp.video;
    delete imp.native;
    delete imp.audio;
    // The module's imp.bidfloor priced the whole multi format bid; this imp takes its part's floor.
    delete imp.bidfloor;
    delete imp.bidfloorcur;
    imp[part] = entry.imp[part];
    out.push(imp);
  });

  if (mergedSources.length > 0) {
    // Multi format imp (Legacy removeSiteIDs): siteID moves from banner.format[].ext to imp.ext.
    const source = mergedSources[0];
    let siteID = deepAccess(source, 'ext.siteID');
    bannerImp.banner.format = bannerImp.banner.format.map((format) => {
      if (format.ext?.siteID == null) return format;
      siteID = format.ext.siteID;
      const stripped = { ...format, ext: { ...format.ext } };
      delete stripped.ext.siteID;
      if (Object.keys(stripped.ext).length === 0) delete stripped.ext;
      return stripped;
    });
    bannerImp.ext = { ...(source.ext || {}), ...(bannerImp.ext || {}) };
    if (siteID != null) bannerImp.ext.siteID = siteID;
  }

  return out;
}

/**
 * Recreate the IX Legacy impression semantics that are not provided by the
 * generic ORTB converter. The converter emits one imp per IX bid; Legacy emits
 * per ad unit (adUnitCode):
 * - one consolidated Banner imp built from all size specific IX entries;
 * - one Video imp (last valid IX entry) and one Native imp (last IX entry),
 *   merged into the Banner imp when they share its id (a single IX entry);
 * - no Video part for an IX entry whose video config Legacy would reject.
 *
 * The original IX bid requests are the source of truth for format ordering,
 * per format siteID/floor association, and the logical impression metadata.
 */
export function consolidateLegacyBannerImpressions(request, validBidRequests, bidderRequest) {
  if (!request || !Array.isArray(request.imp) || !Array.isArray(validBidRequests)) return request;

  const impById = new Map(request.imp.map((imp) => [imp?.id, imp]));
  const groups = new Map();

  validBidRequests.forEach((bidRequest) => {
    const imp = impById.get(bidRequest?.bidId);
    if (!imp || !(imp.banner || imp.video || imp.native)) return;
    // Group by adUnitCode exactly like the Legacy adapter (bannerImps/videoImps/nativeImps[adUnitCode]).
    // Transaction IDs are not used: they are withheld from bidders unless enableTIDs is set,
    // can be overridden per bid, and Prebid assigns them per adUnitCode anyway.
    const key = bidRequest.adUnitCode;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push({ bidRequest, imp });
  });

  if (groups.size === 0) return request;

  const paapiEnabled = !!deepAccess(bidderRequest, 'paapi.enabled');
  const grouped = new Set();
  const ordered = { banner: [], video: [], native: [] };

  groups.forEach((group) => {
    group.forEach(({ imp }) => grouped.add(imp.id));
    let dropped = false;
    const entries = group.map(({ bidRequest, imp }) => {
      if (imp.video && !isLegacyVideoValid(bidRequest)) {
        dropped = true;
        const { video, ...rest } = imp;
        return { bidRequest, imp: rest };
      }
      return { bidRequest, imp };
    });

    const single = entries.length === 1 && !dropped;
    const imps = (single && !entries[0].imp.banner)
      // A single Video/Native IX entry is already what Legacy sends.
      ? [entries[0].imp]
      : buildLegacyAdUnitImps(entries, paapiEnabled);
    if (imps.length === 0) return;
    imps.forEach(setImpFloor);

    // Legacy emits ad units with Banner first, then Video only, then Native only (combineImps)
    if (imps.some((imp) => imp.banner)) ordered.banner.push(...imps);
    else if (imps.some((imp) => imp.video)) ordered.video.push(...imps);
    else ordered.native.push(...imps);
  });

  request.imp = [
    ...request.imp.filter((imp) => !grouped.has(imp?.id)),
    ...ordered.banner,
    ...ordered.video,
    ...ordered.native,
  ];

  return request;
}

/**
 * Build ORTB request payload and endpoint URL using the converter, then add IX specifics.
 */
export function buildRequestsORTBConverter(validBidRequests, bidderRequest, ortbState = getOrtbConverterState()) {
  let r = converter.toORTB({ bidRequests: validBidRequests, bidderRequest });

  // Restore IX specific logical Banner semantics lost by the generic converter.
  r = consolidateLegacyBannerImpressions(r, validBidRequests, bidderRequest);
  // Legacy sends no request when every impression was dropped (e.g. invalid video only).
  if (!Array.isArray(r.imp) || r.imp.length === 0) return [];

  r.ext.ixdiag = buildIXDiag(validBidRequests, bidderRequest, r.imp, ortbState);
  // Legacy flags usid when a multi format imp carries its siteID on imp.ext (removeSiteIDs)
  if (r.imp.some((imp) => imp.banner && (imp.video || imp.native) && imp.ext?.siteID != null)) {
    r.ext.ixdiag.usid = true;
  }

  // User: the converter's user (first party data), plus the IX processed EIDs and addtl_consent
  const eids = getEidInfo(deepAccess(validBidRequests, '0.userIdAsEids')).toSend;
  if (eids.length > 0) deepSetValue(r, 'user.eids', eids);
  const addtlConsent = bidderRequest?.gdprConsent?.addtlConsent;
  if (addtlConsent && hasOwn(bidderRequest.gdprConsent, 'consentString')) {
    deepSetValue(r, 'user.ext.consented_providers_settings.addtl_consent', addtlConsent);
  }

  if (typeof document !== 'undefined' && document.referrer && !deepAccess(r, 'site.ref')) {
    deepSetValue(r, 'site.ref', document.referrer);
  }

  // Legacy always sends GDPR signals from bidderRequest.gdprConsent; fill them in
  // when Prebid's ortb2 enrichment did not already provide them.
  const gdpr = bidderRequest?.gdprConsent;
  if (gdpr) {
    if (hasOwn(gdpr, 'gdprApplies') && deepAccess(r, 'regs.ext.gdpr') == null) {
      deepSetValue(r, 'regs.ext.gdpr', gdpr.gdprApplies ? 1 : 0);
    }
    if (hasOwn(gdpr, 'consentString') && deepAccess(r, 'user.ext.consent') == null) {
      deepSetValue(r, 'user.ext.consent', gdpr.consentString || '');
    }
  }

  // Legacy always sends the page URL; Prebid normally provides it via ortb2.site.page.
  const refererPage = deepAccess(bidderRequest, 'refererInfo.page');
  if (!deepAccess(r, 'site.page') && refererPage) deepSetValue(r, 'site.page', refererPage);

  // Restore browser screen dimensions that cannot be recreated server side.
  r.device = r.device || {};
  if (typeof window !== 'undefined' && window.screen) {
    r.device.w = window.screen.width;
    r.device.h = window.screen.height;
  }

  // Attach requested feature toggles
  r = addRequestedFeatureToggles(r, FEATURE_TOGGLES.REQUESTED_FEATURE_TOGGLES, ortbState);

  // Build endpoint URL (preserve param order: s then p)
  const siteId = deepAccess(validBidRequests, '0.params.siteId');
  const params = new URLSearchParams();
  if (siteId != null) params.set('s', siteId);
  if (isExchangeIdConfigured()) params.set('p', config.getConfig('exchangeId'));
  const exchangeURL = `${SECURE_BID_URL}?${params.toString()}`;

  return { method: 'POST', url: exchangeURL, data: r, options: { contentType: 'text/plain', withCredentials: true }, validBidRequests, ixOrtbConverter: true };
}

function getDivIdFromAdUnitCode(adUnitCode) {
  if (typeof document !== 'undefined' && document.getElementById(adUnitCode)) return adUnitCode;
  return getGptSlotInfoForAdUnitCode(adUnitCode)?.divId;
}

/**
 * The ad units Legacy keys its diagnostics by, in Legacy order (combineImps):
 * ad units with Banner first, then Video only, then Native only, each in bid order.
 * Only ad units that still have an imp count (an ad unit whose only part was an
 * invalid video is dropped, as in Legacy). `bid` is the IX entry Legacy reads
 * params.tagId from: the last Banner entry, or the entry whose Video/Native imp is sent.
 */
function getLegacyDiagAdUnits(validBidRequests, imps) {
  const impById = new Map((imps || []).map((imp) => [imp?.id, imp]));
  const bidsByCode = new Map();
  (validBidRequests || []).forEach((bidRequest) => {
    if (!bidsByCode.has(bidRequest.adUnitCode)) bidsByCode.set(bidRequest.adUnitCode, []);
    bidsByCode.get(bidRequest.adUnitCode).push(bidRequest);
  });

  const banner = [];
  const video = [];
  const native = [];
  bidsByCode.forEach((bids, code) => {
    const sent = bids.filter((bidRequest) => impById.has(bidRequest.bidId));
    if (sent.length === 0) return;
    if (bids.some((bidRequest) => deepAccess(bidRequest, 'mediaTypes.banner'))) {
      banner.push({ code, bid: bids[bids.length - 1] });
      return;
    }
    const videoBid = sent.find((bidRequest) => impById.get(bidRequest.bidId).video);
    if (videoBid) {
      video.push({ code, bid: videoBid });
      return;
    }
    native.push({ code, bid: sent[sent.length - 1] });
  });
  return [...banner, ...video, ...native];
}

/**
 * Build IX diagnostics payload (ixdiag).
 */
function buildIXDiag(validBidRequests, bidderRequest, imps, ortbState) {
  const allEids = deepAccess(validBidRequests, '0.userIdAsEids', []);
  const userIds = deepAccess(validBidRequests, '0.userId', {});
  const userSyncConfig = config.getConfig('userSync');

  const ixdiag = {
    mfu: 0, // multi format units
    bu: 0, // banner units
    iu: 0, // instream units
    nu: 0, // native units
    ou: 0, // outstream units
    allu: 0, // total units
    ren: false, // IX renderer preferred
    version: getIXDiagVersion('$prebid.version$', ortbState),
    userIds: Object.keys(userIds).length > 0 ? Object.keys(userIds) : [],
    url: window.location.href.split('?')[0],
    vpd: validBidRequests.some((b) => defaultVideoPlacementBids.has(b)),
    ae: deepAccess(bidderRequest, 'paapi.enabled'),
    eidLength: allEids.length,
    ls: storage.localStorageIsEnabled(),
    tmax: deepAccess(bidderRequest, 'timeout'),
    syncsPerBidder: userSyncConfig !== undefined ? userSyncConfig.syncsPerBidder : null,
  };

  // Legacy only sets fpd when first party data was merged; it never sends fpd: false
  if (Object.keys(deepAccess(bidderRequest, 'ortb2', {}) || {}).length > 0) ixdiag.fpd = true;

  // Legacy counts ad units (Object.keys(impressions)), not imps on the wire, and
  // overwrites tagid/adunitcode/divId per ad unit, so the last one in its order wins.
  const diagAdUnits = getLegacyDiagAdUnits(validBidRequests, imps);
  ixdiag.imps = diagAdUnits.length;
  const lastUnit = diagAdUnits[diagAdUnits.length - 1];
  if (lastUnit) {
    const tagId = deepAccess(lastUnit.bid, 'params.tagId');
    if (tagId) ixdiag.tagid = tagId;
    ixdiag.adunitcode = lastUnit.code;
    const divId = getDivIdFromAdUnitCode(lastUnit.code);
    if (divId) ixdiag.divId = divId;
  }

  // Match Legacy diagnostics: count logical ad units, not raw size specific
  // IX bid entries. The first bid for each adUnitCode defines its unit type.
  const adUnitCodes = validBidRequests
    .map((bidRequest) => bidRequest.adUnitCode)
    .filter((value, index, arr) => arr.indexOf(value) === index);

  adUnitCodes.forEach((adUnitCode) => {
    const bid = validBidRequests.find((bidRequest) => bidRequest.adUnitCode === adUnitCode);
    if (deepAccess(bid, 'mediaTypes')) {
      if (Object.keys(bid.mediaTypes).length > 1) ixdiag.mfu++;
      if (deepAccess(bid, 'mediaTypes.native')) ixdiag.nu++;
      if (deepAccess(bid, 'mediaTypes.banner')) ixdiag.bu++;
      if (deepAccess(bid, 'mediaTypes.video.context') === 'outstream') {
        ixdiag.ou++;
        if (isIndexRendererPreferred(bid)) ixdiag.ren = true;
      }
      if (deepAccess(bid, 'mediaTypes.video.context') === 'instream') ixdiag.iu++;
      ixdiag.allu++;
    }
  });

  return ixdiag;
}

/** Feature toggles fetched from server and persisted for 1 hour. */
export const FEATURE_TOGGLES = {
  REQUESTED_FEATURE_TOGGLES: ['pbjs_enable_ortbconverter'],
  featureToggles: {},

  isFeatureEnabled(ft) {
    return deepAccess(this.featureToggles, `features.${ft}.activated`, false);
  },

  hasFeature(ft) {
    // Same semantics as the Legacy adapter's original hasFeature (truthy check).
    return !!deepAccess(this.featureToggles, `features.${ft}`);
  },

  getFeatureToggles() {
    if (storage.localStorageIsEnabled()) {
      const parsedToggles = safeJSONParse(storage.getDataFromLocalStorage(LOCAL_STORAGE_FEATURE_TOGGLES_KEY));
      if (deepAccess(parsedToggles, 'expiry') && parsedToggles.expiry >= new Date().getTime()) {
        this.featureToggles = parsedToggles;
      } else {
        this.clearFeatureToggles();
      }
    }
  },

  setFeatureToggles(serverResponse) {
    const responseBody = serverResponse.body;
    const expiryTime = new Date();
    const toggles = deepAccess(responseBody, 'ext.features');

    if (toggles) {
      this.featureToggles = {
        expiry: expiryTime.setHours(expiryTime.getHours() + 1),
        features: toggles,
      };
      if (storage.localStorageIsEnabled()) {
        storage.setDataInLocalStorage(LOCAL_STORAGE_FEATURE_TOGGLES_KEY, JSON.stringify(this.featureToggles));
      }
    }
  },

  clearFeatureToggles() {
    this.featureToggles = {};
    if (storage.localStorageIsEnabled()) storage.removeDataFromLocalStorage(LOCAL_STORAGE_FEATURE_TOGGLES_KEY);
  },
};

const ORTB_CONVERTER_DIAG_VERSION = 2;
const ORTB_CONVERTER_FEATURE = 'pbjs_enable_ortbconverter';

/**
 * Snapshot of the client side ORTB converter assignment. Taken once per buildRequests()
 * call and used for path selection, ext.features, ixdiag.version and the response
 * parser marker, so all four always agree for a given request.
 */
export function getOrtbConverterState() {
  const assigned = FEATURE_TOGGLES.hasFeature(ORTB_CONVERTER_FEATURE);
  const enabled = assigned && FEATURE_TOGGLES.isFeatureEnabled(ORTB_CONVERTER_FEATURE);
  return {
    assigned,
    enabled,
    cohort: !assigned ? 'default' : (enabled ? 'enabled' : 'disabled'),
  };
}

/**
 * Build the ixdiag version string: the Prebid version, the ORTB converter state
 * and the diagnostics format version.
 *
 * Examples:
 * - 11.13.0-ortb-enabled-2
 * - 11.13.0-ortb-disabled-2
 * - 11.13.0-ortb-default-2
 */
export function getIXDiagVersion(baseVersion = '$prebid.version$', ortbState = getOrtbConverterState()) {
  // Same fallback as the original branch when the build placeholder is not replaced.
  const version = /^\d+\.\d+\.\d+/.test(baseVersion) ? baseVersion : '10.18.0';
  return `${version}-ortb-${ortbState.cohort}-${ORTB_CONVERTER_DIAG_VERSION}`;
}

/**
 * Attach requested feature toggles to the request payload.
 */
export function addRequestedFeatureToggles(r, requestedFeatureToggles, ortbState) {
  if (requestedFeatureToggles.length > 0) {
    r.ext.features = {};
    requestedFeatureToggles.forEach((toggle) => {
      const activated = toggle === ORTB_CONVERTER_FEATURE && ortbState
        ? ortbState.enabled
        : FEATURE_TOGGLES.isFeatureEnabled(toggle);
      r.ext.features[toggle] = { activated };
    });
  }
  return r;
}

/**
 * Whether IX’s outstream renderer should be preferred over a provided renderer.
 */
export function isIndexRendererPreferred(bid) {
  if (deepAccess(bid, 'mediaTypes.video.context') !== OUTSTREAM) return false;
  let renderer = deepAccess(bid, 'mediaTypes.video.renderer') || deepAccess(bid, 'renderer');
  const isValid = !!(typeof renderer === 'object' && renderer?.url && renderer?.render);
  return Boolean(!isValid || renderer.backupOnly);
}

/**
 * Populate displaymanager hint on the imp for outstream use cases.
 */
export function setDisplayManager(imp, bid) {
  if (deepAccess(bid, 'mediaTypes.video.context') === OUTSTREAM) {
    let renderer = deepAccess(bid, 'mediaTypes.video.renderer') || deepAccess(bid, 'renderer');

    if (deepAccess(bid, 'schain', false)) {
      imp.displaymanager = 'pbjs_wrapper';
    } else if (renderer && typeof renderer === 'object') {
      if (renderer.url !== undefined) {
        let domain = '';
        try {
          domain = new URL(renderer.url).hostname;
        } catch {
          return;
        }
        if (domain.includes('js-sec.indexww')) {
          imp.displaymanager = 'ix';
        } else {
          imp.displaymanager = renderer.url;
        }
      }
    } else {
      imp.displaymanager = 'ix';
    }
  }
}

/**
 * Render function for IX outstream player.
 */
export function outstreamRenderer(bid) {
  bid.renderer.push(function () {
    const adUnitCode = bid.adUnitCode;
    const divId = document.getElementById(adUnitCode) ? adUnitCode : getGptSlotInfoForAdUnitCode(adUnitCode).divId;
    if (!divId) {
      logWarn(`IX Bid Adapter: adUnitCode: ${divId} not found on page.`);
      return;
    }
    window.createIXPlayer(divId, bid);
  });
}

/**
 * Install a Prebid renderer for IX outstream.
 */
export function createRenderer(id, renderUrl) {
  const renderer = Renderer.install({ id, url: renderUrl, loaded: false });

  try {
    renderer.setRender(outstreamRenderer);
  } catch (err) {
    logWarn('Prebid Error calling setRender on renderer', err);
    return null;
  }

  if (!renderUrl) {
    logWarn('Outstream renderer URL not found');
    return null;
  }

  return renderer;
}

/**
 * Normalize and cap EIDs from Prebid userIdAsEids.
 */
export function getEidInfo(allEids) {
  const toSend = [];
  const seenSources = {};
  if (isArray(allEids)) {
    for (const eid of allEids) {
      const isSourceMapped = Object.prototype.hasOwnProperty.call(SOURCE_RTI_MAPPING, eid.source);
      const hasUids = deepAccess(eid, 'uids.0');
      if (hasUids) {
        seenSources[eid.source] = true;
        if (isSourceMapped && SOURCE_RTI_MAPPING[eid.source] !== '') {
          eid.uids[0].ext = { rtiPartner: SOURCE_RTI_MAPPING[eid.source] };
        }
        toSend.push(eid);
        if (toSend.length >= MAX_EID_SOURCES) break;
      }
    }
  }
  return { toSend, seenSources };
}

/**
 * Log a server side error returned by the IX endpoint.
 * Serializes the provided error payload with `JSON.stringify` and emits a
 * `logWarn` message along with the IAB no bid reason (if provided)
 */
function logIXServerError(errObj, nbr) {
  if (errObj) {
    const msg = JSON.stringify(errObj)
    logWarn(`IX server error${nbr != null ? ` (nbr=${nbr})` : ''}: ${msg}`);
  }
}
