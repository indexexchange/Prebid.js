/**
 * IX Bid Adapter (ORTB Converter Integration)
 */
import { ortbConverter } from '../ortbConverter/converter.js';
import { BANNER, VIDEO, NATIVE } from '../../src/mediaTypes.js';
import { deepAccess, logWarn, deepSetValue, safeJSONParse, isFn, isArray, mergeDeep } from '../../src/utils.js';
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
const FLOOR_SOURCE = { PBJS: 'p', IX: 'i' };
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
 * Remove empty nested objects in-place.
 * @param {object} obj
 */
function pruneEmpty(obj) {
  if (!obj || typeof obj !== 'object') return;
  Object.keys(obj).forEach((k) => {
    const v = obj[k];
    if (v && typeof v === 'object') {
      pruneEmpty(v);
      if (Object.keys(v).length === 0) delete obj[k];
    }
  });
}

/**
 * Resolve a [w, h] pair for video from (in order):
 * 1) mediaTypes.video.playerSize, 2) params.size, 3) sizes
 * @param {object} bid - a single validBidRequest
 * @return {[number, number]|null}
 */
function resolveVideoSize(bid) {
  let ps = deepAccess(bid, 'mediaTypes.video.playerSize');
  if (Array.isArray(ps) && ps.length) {
    const first = Array.isArray(ps[0]) ? ps[0] : ps;
    if (Array.isArray(first) && first.length === 2 && Number.isFinite(first[0]) && Number.isFinite(first[1])) {
      return first;
    }
  }

  const psize = deepAccess(bid, 'params.size');
  if (Array.isArray(psize) && psize.length === 2 && Number.isFinite(psize[0]) && Number.isFinite(psize[1])) {
    return psize;
  }

  const sizes = bid?.sizes;
  if (Array.isArray(sizes) && sizes.length) {
    const first = Array.isArray(sizes[0]) ? sizes[0] : sizes;
    if (Array.isArray(first) && first.length === 2 && Number.isFinite(first[0]) && Number.isFinite(first[1])) {
      return first;
    }
  }
  return null;
}

/**
 * Whether an Exchange ID is configured (string/number with numeric value).
 */
export function isExchangeIdConfigured() {
  const exchangeId = config.getConfig('exchangeId');
  if (typeof exchangeId === 'number' && isFinite(exchangeId)) return true;
  if (typeof exchangeId === 'string' && exchangeId.trim() !== '' && isFinite(Number(exchangeId))) return true;
  return false;
}

/**
 * Move siteID to imp.ext.siteID for multiformat adunits (single source of truth).
 * Cleans up any duplicated siteID under each media type ext.
 * @param {object} imp
 * @return {object}
 */
function manageSiteID(imp) {
  if (!imp) return imp;
  const mediatypes = [BANNER, VIDEO, NATIVE];

  if (deepAccess(imp, 'banner.ext.siteID', false)) {
    deepSetValue(imp, 'ext.siteID', imp.banner.ext.siteID);
  } else if (deepAccess(imp, 'video.ext.siteID', false)) {
    deepSetValue(imp, 'ext.siteID', imp.video.ext.siteID);
  } else if (imp.native?.ext?.siteID) {
    deepSetValue(imp, 'ext.siteID', imp.native.ext.siteID);
  }

  mediatypes.forEach((type) => {
    if (imp[type]?.ext) {
      delete imp[type].ext.siteID;
      if (Object.keys(imp[type].ext).length === 0) {
        delete imp[type].ext;
      }
    }
    if (type === BANNER && Array.isArray(imp[type]?.format)) {
      imp[type].format.forEach((format) => {
        if (format.ext) {
          delete format.ext.siteID;
          if (!Object.keys(format.ext).length) delete format.ext;
        }
      });
    }
  });

  return imp;
}

/**
 * Detect if an ad unit is multiformat (banner+video, banner+native, video+native).
 * @param {object} bidRequest
 */
function isMultiformat(bidRequest) {
  const mt = bidRequest?.mediaTypes || {};
  return SUPPORTED_AD_TYPES
    .filter(t => Object.prototype.hasOwnProperty.call(mt, t))
    .length > 1;
}

export const converter = ortbConverter({
  context: {
    netRevenue: true,
  },

  /**
   * Request stage: runs once with the array of imps. Ensures regs/consent, page,
   * schain, and common request-level ext fields are set.
   */
  request(buildRequest, imps, bidderRequest, context) {
    const ctx = { ...context, bidderRequest };
    const request = buildRequest(imps, bidderRequest, ctx);

    request.at = 1;
    request.ext = request.ext || {};
    request.ext.source = 'prebid';
    request.ext.ixdiag = {};

    return request;
  },
  /**
   * Imp stage: runs once per valid bidRequest. Ensures placement, size,
   * floors, siteID, and other imp-level ext fields are set.
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
            imp.video.placement = 5; // in-article/float on scroll
          } else {
            imp.video.placement = 3; // outstream
            bidRequest.defaultVideoPlacement = true; // used by diagnostics
          }
        }
      }

      // Ensure w/h are set for video
      const sz = resolveVideoSize(bidRequest);
      if (sz) {
        imp.video = imp.video || {};
        if (imp.video.w == null) imp.video.w = sz[0];
        if (imp.video.h == null) imp.video.h = sz[1];
      }
    }

    // imp-level siteID
    if (bidRequest.params?.siteId && !deepAccess(imp, 'ext.siteID')) {
      deepSetValue(imp, 'ext.siteID', String(bidRequest.params.siteId));
    }

    // Ensure NATIVE request/ver exist when a native ORTB request is supplied
    if (bidRequest.nativeOrtbRequest && !deepAccess(imp, 'native.request')) {
      const req = { ...bidRequest.nativeOrtbRequest };
      req.eventtrackers = req.eventtrackers || [{ event: 1, methods: [1, 2] }];
      if (req.privacy == null) req.privacy = 1;
      req.ver = req.ver || '1.2';
      deepSetValue(imp, 'native.request', JSON.stringify(req));
      deepSetValue(imp, 'native.ver', '1.2');
    }

    // Floor Logic
    applyFloors(imp, bidRequest);

    // Imp ext.sid (IX per-adunit ID), ext.tid (transaction/trace id)
    if (bidRequest.params?.hasOwnProperty('id')) {
      deepSetValue(imp, 'ext.sid', String(bidRequest.params.id));
    }

    const tid = deepAccess(bidRequest, 'ortb2Imp.ext.tid');
    if (tid) deepSetValue(imp, 'ext.tid', tid);

    const dfpAdUnitCode = deepAccess(bidRequest, 'ortb2Imp.ext.data.adserver.adslot');
    if (dfpAdUnitCode) deepSetValue(imp, 'ext.dfp_ad_unit_code', dfpAdUnitCode);

    // externalID if globally configured
    if (isExchangeIdConfigured() && deepAccess(bidRequest, 'params.externalId')) {
      deepSetValue(imp, 'ext.externalID', bidRequest.params.externalId);
    }

    setDisplayManager(imp, bidRequest);

    // Multiformat: keep siteID only at imp.ext
    if (isMultiformat(bidRequest)) manageSiteID(imp);

    return imp;
  },
  /**
   * BidResponse stage: normalize currency/CPM, native ADM, attach renderer,
   * sizes, ttl, meta, and various pass-through fields.
   */
  bidResponse(buildBidResponse, bid, context) {
    logIXServerError(deepAccess(context, 'ortbResponse.ext.errors'), deepAccess(context, 'ortbResponse.ext.nbr'))

    const currency = deepAccess(context, 'ortbResponse.cur') || 'USD';
    bid.currency = currency;

    // Native normalization: Remove ORTB native wrapper {"native": {...}} into the inner payload when mtype=Native
    if (bid?.mtype === MEDIA_TYPES.Native && typeof bid.adm === 'string' && bid.adm.trim().startsWith('{')) {
      const parsed = safeJSONParse(bid.adm);
      const inner = parsed && parsed.native;
      if (inner != null) bid.adm = typeof inner === 'string' ? inner : JSON.stringify(inner);
    }

    const bidResponse = buildBidResponse(bid, context);

    const normalizedCpm = Object.prototype.hasOwnProperty.call(PRICE_TO_DOLLAR_FACTOR, currency)
      ? bid.price / PRICE_TO_DOLLAR_FACTOR[currency]
      : bid.price / CENT_TO_DOLLAR_FACTOR;

    bidResponse.currency = currency;
    bidResponse.cpm = normalizedCpm;

    if (typeof bid.exp === 'number') bidResponse.ttl = bid.exp;

    // Video-specific fields
    if (bidResponse.mediaType === VIDEO) {
      // Prefer server-reported size if present, else fall back to the original imp size
      const imps = deepAccess(context, 'ortbRequest.imp', []);
      const imp = Array.isArray(imps) ? imps.find((i) => i && i.id === bid.impid) : null;
      const vw = bid.w ?? deepAccess(imp, 'video.w');
      const vh = bid.h ?? deepAccess(imp, 'video.h');
      if (vw != null) bidResponse.playerWidth = vw;
      if (vh != null) bidResponse.playerHeight = vh;

      // Inline VAST (adm) - vastXml
      if (typeof bid.adm === 'string' && bid.adm.length) bidResponse.vastXml = bid.adm;

      // Outstream renderer: attach IX renderer if preferred and URL provided
      if (isIndexRendererPreferred(context.bidRequest)) {
        const rendererUrl = deepAccess(context, 'ortbResponse.ext.videoplayerurl');
        if (rendererUrl) bidResponse.renderer = createRenderer(bid.id, rendererUrl);
      }

      // VAST URL passthrough
      if (bid.ext?.vasturl) bidResponse.vastUrl = bid.ext.vasturl;
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
   *   runs, and (b) append IX-specific fields after the base builder runs.
   */
  overrides: {
    imp: {
      /**
       * Banner override: merge params - mediaTypes.banner and copy siteID to banner.ext + imp.ext.
       */
      banner(orig, imp, bidRequest, context) {
        let bannerParams = bidRequest.mediaTypes[BANNER];
        if (bannerParams) {
          bannerParams = Object.assign({}, bannerParams, bidRequest.params?.banner);
          bidRequest = { ...bidRequest, mediaTypes: { [BANNER]: bannerParams } };
        }
        if (bannerParams && bannerParams.siteId !== undefined) {
          deepSetValue(imp, 'banner.ext.siteID', String(bannerParams.siteId));
          deepSetValue(imp, 'ext.siteID', String(bannerParams.siteId));
        }
        orig(imp, bidRequest, context);
      },

      /**
       * Video override: merge params - mediaTypes.video, propagate siteID, and
       * copy adunit-specific adserver data (ortb2Imp.ext.data.adserver) into imp.ext.data.adserver.
       */
      video(orig, imp, bidRequest, context) {
        let videoParams = bidRequest.mediaTypes[VIDEO];
        if (videoParams) {
          videoParams = Object.assign({}, videoParams, bidRequest.params?.video);
          bidRequest = { ...bidRequest, mediaTypes: { [VIDEO]: videoParams } };
          if (videoParams.siteId !== undefined) {
            deepSetValue(imp, 'video.ext.siteID', String(videoParams.siteId));
            if (!deepAccess(imp, 'ext.siteID', false)) deepSetValue(imp, 'ext.siteID', String(videoParams.siteId));
          }
        }

        orig(imp, bidRequest, context);

        // Copy adunit-specific adserver data for VIDEO
        const adserver = deepAccess(bidRequest, 'ortb2Imp.ext.data.adserver');
        if (adserver) {
          imp.ext = imp.ext || {};
          imp.ext.data = imp.ext.data || {};
          const existing = imp.ext.data.adserver || {};
          imp.ext.data.adserver = { ...existing, ...adserver };
        }
      },

      /**
       * Native override: normalize nativeOrtbRequest and propagate siteId.
       */
      native(orig, imp, bidRequest, context) {
        if (bidRequest.nativeOrtbRequest) {
          const req = { ...bidRequest.nativeOrtbRequest };
          req.eventtrackers = [{ event: 1, methods: [1, 2] }];
          req.privacy = 1;
          req.ver = '1.2';
          bidRequest.nativeOrtbRequest = req;
        }

        let nativeParams = bidRequest.mediaTypes[NATIVE];
        if (nativeParams) {
          nativeParams = Object.assign({}, nativeParams, bidRequest.params?.native);
          bidRequest = { ...bidRequest, mediaTypes: { [NATIVE]: nativeParams } };
        }
        if (nativeParams && nativeParams.siteId != null) {
          deepSetValue(imp, 'native.ext.siteID', String(nativeParams.siteId));
          if (!deepAccess(imp, 'ext.siteID', false)) deepSetValue(imp, 'ext.siteID', String(nativeParams.siteId));
        }
        orig(imp, bidRequest, context);
      },
    },
  },
});

/**
 * Convert ORTB response - Prebid bids using the converter and store server-provided feature toggles.
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
 * Apply all publisher FPD (bidderRequest.ortb2) onto the ORTB request `r`
 * using mergeDeep (existing-first arrays + dedup, deep object merge, publisher
 * overwrites primitives). Avoids enumerating fields (site/user/device/app/...).
 *
 * Notes:
 * - We skip overriding module-provided GPP fields if the GPP module is present.
 * - We avoid touching adapter-managed ext fields (features, ixdiag).
 */
function applyPrebidFPD(r, bidderRequest) {
  const fpd = deepAccess(bidderRequest, 'ortb2');
  if (!fpd || typeof fpd !== 'object') return;
  const f = { ...fpd };

  // don't let FPD override consent-driven GPP when the module is present
  if (deepAccess(bidderRequest, 'gppConsent.gppString')) {
    if (f.regs) {
      const { regs } = f;
      f.regs = { ...regs };
      delete f.regs.gpp;
      delete f.regs.gpp_sid;
    }
  }

  if (f.ext) {
    f.ext = { ...f.ext };
    delete f.ext.features;
    delete f.ext.ixdiag;
  }

  delete f.imp; // FPD should not define request.imp

  mergeDeep(r, f);
}

/**
 * Build ORTB request payload and endpoint URL using the converter, then add IX specifics.
 */
export function buildRequestsORTBConverter(validBidRequests, bidderRequest) {
  FEATURE_TOGGLES.getFeatureToggles();

  let r = converter.toORTB({ bidRequests: validBidRequests, bidderRequest });

  r.ext.ixdiag = buildIXDiag(validBidRequests, bidderRequest, r.imp);

  delete r.user;

  // EIDs from Prebid (userIdAsEids)
  const prebidEidsInput = deepAccess(validBidRequests, '0.userIdAsEids');
  const eidInfo = getEidInfo(prebidEidsInput);
  const userEids = eidInfo.toSend;
  if (userEids.length > 0) r.user = { eids: userEids };

  // GDPR consent mapping
  const gdprConsent = deepAccess(bidderRequest, 'gdprConsent');
  if (gdprConsent) {
    const consentStr = gdprConsent.consentString;
    const addtlConsent = gdprConsent.addtlConsent;

    if (consentStr && addtlConsent) {
      deepSetValue(r, 'user.ext.consented_providers_settings.addtl_consent', addtlConsent);
    }
  }

  // Apply Prebid FPD (site + user) with allow-list
  applyPrebidFPD(r, bidderRequest);

  // Attach requested feature toggles
  r = addRequestedFeatureToggles(r, FEATURE_TOGGLES.REQUESTED_FEATURE_TOGGLES);

  // final cleanup
  if (r.user) {
    const hasEids = Array.isArray(r.user.eids) && r.user.eids.length > 0;
    if (!hasEids) delete r.user.eids;
    if (r.user.ext) {
      pruneEmpty(r.user.ext);
      if (Object.keys(r.user.ext).length === 0) delete r.user.ext;
    }
    if (Array.isArray(r.user.data) && r.user.data.length === 0) delete r.user.data;
    if (Object.keys(r.user).length === 0) delete r.user;
  }

  // Build endpoint URL (preserve param order: s then p)
  const siteId = deepAccess(validBidRequests, '0.params.siteId');
  const params = new URLSearchParams();
  if (siteId != null) params.set('s', siteId);
  if (isExchangeIdConfigured()) params.set('p', config.getConfig('exchangeId'));
  const exchangeURL = `${SECURE_BID_URL}?${params.toString()}`;

  return { method: 'POST', url: exchangeURL, data: r, options: { contentType: 'text/plain', withCredentials: true } };
}

/**
 * Build IX diagnostics payload (ixdiag).
 */
function buildIXDiag(validBidRequests, bidderRequest, imps) {
  const allEids = deepAccess(validBidRequests, '0.userIdAsEids', []);
  const userIds = deepAccess(validBidRequests, '0.userId', {});
  const userSyncConfig = config.getConfig('userSync');

  const ixdiag = {
    mfu: 0, // multi-format units
    bu: 0,  // banner units
    iu: 0,  // instream units
    nu: 0,  // native units
    ou: 0,  // outstream units
    allu: 0, // total units
    ren: false, // IX renderer preferred
    version: '$prebid.version$',
    userIds: Object.keys(userIds).length > 0 ? Object.keys(userIds) : [],
    url: window.location.href.split('?')[0],
    vpd: validBidRequests.some((b) => deepAccess(b, 'defaultVideoPlacement', false)),
    ae: deepAccess(bidderRequest, 'paapi.enabled'),
    fpd: Object.keys(deepAccess(bidderRequest, 'ortb2', {})).length > 0,
    eidLength: allEids.length,
    ls: storage.localStorageIsEnabled(),
    tmax: deepAccess(bidderRequest, 'timeout'),
    syncsPerBidder: userSyncConfig !== undefined ? userSyncConfig.syncsPerBidder : null,
    imps: imps.length
  };

  ixdiag.version = `${/^\d+\.\d+\.\d+/.test('$prebid.version$') ? '$prebid.version$' : '10.17.0'}-ortb-enabled`;
  const firstBid = validBidRequests && validBidRequests[0];
  if (firstBid) {
    if (firstBid.params && firstBid.params.tagId) ixdiag.tagid = firstBid.params.tagId;
    if (firstBid.adUnitCode) ixdiag.adunitcode = firstBid.adUnitCode;
    const gpt = getGptSlotInfoForAdUnitCode(firstBid.adUnitCode);
    if (gpt && gpt.divId) ixdiag.divId = gpt.divId;
  }

  validBidRequests.forEach((bid) => {
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

/**
 * Attach requested feature toggles to the request payload.
 */
export function addRequestedFeatureToggles(r, requestedFeatureToggles) {
  if (requestedFeatureToggles.length > 0) {
    r.ext.features = {};
    requestedFeatureToggles.forEach((toggle) => {
      r.ext.features[toggle] = { activated: FEATURE_TOGGLES.isFeatureEnabled(toggle) };
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

    if (deepAccess(bid, 'ortb2.source.ext.schain', false)) {
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
 * Apply floors to an impression object.
 */
export function applyFloors(imp, bidRequest) {
  const hasGetFloor = isFn(bidRequest?.getFloor);
  const params = bidRequest?.params;
  const adapterFloor = (params?.bidFloor && params?.bidFloorCur)
    ? { floor: Number(params.bidFloor), currency: params.bidFloorCur }
    : null;

  const chooseFloor = (moduleFloor, adapterFloor) => {
    if (moduleFloor && typeof moduleFloor.floor === 'number') {
      return { floor: moduleFloor.floor, currency: moduleFloor.currency, source: FLOOR_SOURCE.PBJS };
    }
    if (adapterFloor && typeof adapterFloor.floor === 'number') {
      return { floor: adapterFloor.floor, currency: adapterFloor.currency, source: FLOOR_SOURCE.IX };
    }
    return null;
  };

  // Banner: per-format floors & siteID
  if (deepAccess(imp, 'banner.format', false) && Array.isArray(imp.banner.format)) {
    imp.banner.format = imp.banner.format.map((format) => {
      const fmt = { ...format, ext: { ...(format.ext || {}) } };

      // priceFloors module per size
      const moduleFloor = hasGetFloor
        ? bidRequest.getFloor({ mediaType: 'banner', size: [format.w, format.h] })
        : null;

      const picked = chooseFloor(moduleFloor, adapterFloor);
      if (picked) {
        fmt.ext.bidfloor = picked.floor;
        fmt.ext.bidfloorcur = picked.currency;
        fmt.ext.fl = picked.source;
      }

      // propagate siteID into each format
      if (deepAccess(imp, 'ext.siteID', false)) {
        fmt.ext.siteID = imp.ext.siteID;
      }

      if (Object.keys(fmt.ext).length === 0) delete fmt.ext;
      return fmt;
    });

    // Imp-level lowest floor across formats that actually set one
    const reduced = imp.banner.format.reduce((acc, f) => {
      const fl = f?.ext?.bidfloor;
      if (typeof fl === 'number' && fl < acc.floor) {
        acc.floor = fl;
        acc.currency = f.ext?.bidfloorcur || acc.currency;
      }
      return acc;
    }, { floor: Infinity, currency: 'USD' });

    if (reduced.floor < Infinity) {
      deepSetValue(imp, 'bidfloor', reduced.floor);
      deepSetValue(imp, 'bidfloorcur', reduced.currency);
    } else if (adapterFloor) {
      // If no format had a floor (e.g., priceFloors off) but adapter has one, set imp-level
      deepSetValue(imp, 'bidfloor', adapterFloor.floor);
      deepSetValue(imp, 'bidfloorcur', adapterFloor.currency);
      deepSetValue(imp, 'ext.fl', FLOOR_SOURCE.IX);
    }
  }

  // Video: module or adapter (module wins)
  if (imp.video) {
    const size = (imp.video.w && imp.video.h) ? [imp.video.w, imp.video.h] : undefined;
    const moduleFloor = hasGetFloor ? bidRequest.getFloor({ mediaType: 'video', size }) : null;
    const picked = chooseFloor(moduleFloor, adapterFloor);
    if (picked) {
      deepSetValue(imp, 'video.ext.bidfloor', picked.floor);
      deepSetValue(imp, 'video.ext.bidfloorcur', picked.currency);
      deepSetValue(imp, 'video.ext.fl', picked.source);
      if (typeof imp.bidfloor === 'number' && picked.floor < imp.bidfloor) {
        imp.bidfloor = picked.floor;
        imp.bidfloorcur = picked.currency;
      }
    }
  }

  // Native: module or adapter (module wins)
  if (imp.native) {
    const moduleFloor = hasGetFloor ? bidRequest.getFloor({ mediaType: 'native' }) : null;
    const picked = chooseFloor(moduleFloor, adapterFloor);
    if (picked) {
      deepSetValue(imp, 'native.ext.bidfloor', picked.floor);
      deepSetValue(imp, 'native.ext.bidfloorcur', picked.currency);
      deepSetValue(imp, 'native.ext.fl', picked.source);
      if (typeof imp.bidfloor === 'number' && picked.floor < imp.bidfloor) {
        imp.bidfloor = picked.floor;
        imp.bidfloorcur = picked.currency;
      }
    }
  }
}

/**
 * Log a server-side error returned by the IX endpoint.
 * Serializes the provided error payload with `JSON.stringify` and emits a
 * `logWarn` message along with the IAB no-bid reason (if provided)
 */
function logIXServerError(errObj, nbr) {
  if (errObj) {
    const msg = JSON.stringify(errObj)
    logWarn(`IX server error${nbr != null ? ` (nbr=${nbr})` : ''}: ${msg}`);
  }
}
