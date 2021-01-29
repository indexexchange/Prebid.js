import * as utils from '../src/utils.js';
import { config } from '../src/config.js';
import { EVENTS } from '../src/constants.json';
import { BANNER, VIDEO } from '../src/mediaTypes.js';
import { Renderer } from '../src/Renderer.js';
import { getStorageManager } from '../src/storageManager.js';
import events from '../src/events.js';
import find from 'core-js-pure/features/array/find.js';
import isInteger from 'core-js-pure/features/number/is-integer.js';
import { registerBidder } from '../src/adapters/bidderFactory.js';

const BIDDER_CODE = 'ix';
const GVLID = 10;
const SECURE_BID_URL = 'https://htlb.casalemedia.com/cygnus';
const SUPPORTED_AD_TYPES = [BANNER, VIDEO];
const BANNER_ENDPOINT_VERSION = 7.2;
const VIDEO_ENDPOINT_VERSION = 8.1;
const CENT_TO_DOLLAR_FACTOR = 100;
const BANNER_TIME_TO_LIVE = 300;
const VIDEO_TIME_TO_LIVE = 3600; // 1hr
const NET_REVENUE = true;
const PRICE_TO_DOLLAR_FACTOR = {
  JPY: 1
};
const USER_SYNC_URL = 'https://js-sec.indexww.com/um/ixmatch.html';
const RENDERER_URL = 'https://js-sec.indexww.com/htv/video-player.js';
let hasRegisteredHandler = false;
const storage = getStorageManager(GVLID, BIDDER_CODE);

/**
 * Transform valid bid request config object to banner impression object that will be sent to ad server.

 * @param  {object} bid A valid bid request config object.
 * @return {object}     A impression object that will be sent to ad server.
 */
function bidToBannerImp(bid) {
  const imp = bidToImp(bid);

  imp.banner = {};
  imp.banner.w = bid.params.size[0];
  imp.banner.h = bid.params.size[1];
  imp.banner.topframe = utils.inIframe() ? 0 : 1;

  return imp;
}

/**
 * Transform valid bid request config object to video impression object that will be sent to ad server.
 *
 * @param  {object} bid A valid bid request config object.
 * @return {object}     A impression object that will be sent to ad server.
 */
function bidToVideoImp(bid) {
  const imp = bidToImp(bid);
  const videoAdUnitRef = utils.deepAccess(bid, 'mediaTypes.video');
  const context = utils.deepAccess(bid, 'mediaTypes.video.context');
  const videoAdUnitWhitelist = [
    'mimes', 'minduration', 'maxduration', 'protocols', 'protocol',
    'startdelay', 'placement', 'linearity', 'skip', 'skipmin',
    'skipafter', 'sequence', 'battr', 'maxextended', 'minbitrate',
    'maxbitrate', 'boxingallowed', 'playbackmethod', 'playbackend',
    'delivery', 'pos', 'companionad', 'api', 'companiontype', 'ext'
  ];

  imp.video = utils.deepClone(bid.params.video)
  imp.video.w = bid.params.size[0];
  imp.video.h = bid.params.size[1];

  if (context) {
    if (context === 'instream') {
      imp.video.placement = 1;
    } else if (context === 'outstream') {
      imp.video.placement = 4;
    } else {
      utils.logWarn(`ix bidder params: video context '${context}' is not supported`);
    }
  }

  for (let adUnitProperty in videoAdUnitRef) {
    if (videoAdUnitWhitelist.indexOf(adUnitProperty) !== -1 && !imp.video.hasOwnProperty(adUnitProperty)) {
      imp.video[adUnitProperty] = videoAdUnitRef[adUnitProperty];
    }
  }

  return imp;
}

function bidToImp(bid) {
  const imp = {};

  imp.id = bid.bidId;

  imp.ext = {};
  imp.ext.siteID = bid.params.siteId;

  if (bid.params.hasOwnProperty('id') &&
    (typeof bid.params.id === 'string' || typeof bid.params.id === 'number')) {
    imp.ext.sid = String(bid.params.id);
  } else {
    imp.ext.sid = `${bid.params.size[0]}x${bid.params.size[1]}`;
  }

  if (bid.params.hasOwnProperty('bidFloor') && bid.params.hasOwnProperty('bidFloorCur')) {
    imp.bidfloor = bid.params.bidFloor;
    imp.bidfloorcur = bid.params.bidFloorCur;
  }

  return imp;
}

/**
 * Parses a raw bid for the relevant information.
 *
 * @param  {object} rawBid   The bid to be parsed.
 * @param  {string} currency Global currency in bid response.
 * @return {object} bid      The parsed bid.
 */
function parseBid(rawBid, currency, bidRequest) {
  const bid = {};

  if (PRICE_TO_DOLLAR_FACTOR.hasOwnProperty(currency)) {
    bid.cpm = rawBid.price / PRICE_TO_DOLLAR_FACTOR[currency];
  } else {
    bid.cpm = rawBid.price / CENT_TO_DOLLAR_FACTOR;
  }

  bid.requestId = rawBid.impid;

  bid.dealId = utils.deepAccess(rawBid, 'ext.dealid');
  bid.netRevenue = NET_REVENUE;
  bid.currency = currency;
  bid.creativeId = rawBid.hasOwnProperty('crid') ? rawBid.crid : '-';

  // in the event of a video
  if (utils.deepAccess(rawBid, 'ext.vasturl')) {
    bid.vastUrl = rawBid.ext.vasturl
    bid.width = bidRequest.video.w;
    bid.height = bidRequest.video.h;
    bid.mediaType = VIDEO;
    bid.ttl = VIDEO_TIME_TO_LIVE;
  } else {
    bid.ad = rawBid.adm;
    bid.width = rawBid.w;
    bid.height = rawBid.h;
    bid.mediaType = BANNER;
    bid.ttl = BANNER_TIME_TO_LIVE;
  }

  bid.meta = {};
  bid.meta.networkId = utils.deepAccess(rawBid, 'ext.dspid');
  bid.meta.brandId = utils.deepAccess(rawBid, 'ext.advbrandid');
  bid.meta.brandName = utils.deepAccess(rawBid, 'ext.advbrand');
  if (rawBid.adomain && rawBid.adomain.length > 0) {
    bid.meta.advertiserDomains = rawBid.adomain;
  }

  return bid;
}

/**
 * Determines whether or not the given object is valid size format.
 *
 * @param  {*}       size The object to be validated.
 * @return {boolean}      True if this is a valid size format, and false otherwise.
 */
function isValidSize(size) {
  return Array.isArray(size) && size.length === 2 && isInteger(size[0]) && isInteger(size[1]);
}

/**
 * Determines whether or not the given size object is an element of the size
 * array.
 *
 * @param  {array}  sizeArray The size array.
 * @param  {object} size      The size object.
 * @return {boolean}          True if the size object is an element of the size array, and false
 *                            otherwise.
 */
function includesSize(sizeArray, size) {
  if (isValidSize(sizeArray)) {
    return sizeArray[0] === size[0] && sizeArray[1] === size[1];
  }

  for (let i = 0; i < sizeArray.length; i++) {
    if (sizeArray[i][0] === size[0] && sizeArray[i][1] === size[1]) {
      return true;
    }
  }

  return false;
}

/**
 * Determines whether or not the given bidFloor parameters are valid.
 *
 * @param  {*}       bidFloor    The bidFloor parameter inside bid request config.
 * @param  {*}       bidFloorCur The bidFloorCur parameter inside bid request config.
 * @return {boolean}             True if this is a valid bidFloor parameters format, and false
 *                               otherwise.
 */
function isValidBidFloorParams(bidFloor, bidFloorCur) {
  const curRegex = /^[A-Z]{3}$/;

  return Boolean(typeof bidFloor === 'number' && typeof bidFloorCur === 'string' &&
    bidFloorCur.match(curRegex));
}

/**
 * Finds the impression with the associated id.
 *
 * @param  {*}      id          Id of the impression.
 * @param  {array}  impressions List of impressions sent in the request.
 * @return {object}             The impression with the associated id.
 */
function getBidRequest(id, impressions) {
  if (!id) {
    return;
  }
  return find(impressions, imp => imp.id === id);
}

/**
 * Adds a User ID module's response into user Eids array.
 *
 * @param  {array}  userEids       An array of objects containing user ids,
 *                                 will be attached to bid request later.
 * @param  {object} seenIdPartners An object with Identity partners names already added,
 *                                 updated with new partner name.
 * @param  {*}      id             The id obtained from User ID module.
 * @param  {string} source         The URL of the User ID module.
 * @param  {string} ixlPartnerName The name of the Identity Partner in IX Library.
 * @param  {string} rtiPartner     The name of the User ID provider in Prebid.
 * @return {boolean}               True if successfully added the ID to the userEids, false otherwise.
 */
function addUserEids(userEids, seenIdPartners, id, source, ixlPartnerName, rtiPartner) {
  if (id) {
    // mark the partnername that IX RTI uses
    seenIdPartners[ixlPartnerName] = 1;
    userEids.push({
      source: source,
      uids: [{
        id: id,
        ext: {
          rtiPartner: rtiPartner
        }
      }]
    });
    return true;
  }

  utils.logWarn('Tried to add a user ID from Prebid, the ID received was null');
  return false;
}

/**
 * Builds a request object to be sent to the ad server based on bid requests.
 *
 * @param  {array}  validBidRequests A list of valid bid request config objects.
 * @param  {object} bidderRequest    An object containing other info like gdprConsent.
 * @param  {object} impressions      An object containing a list of impression objects describing the bids for each transactionId
 * @param  {array}  version          Endpoint version denoting banner or video.
 * @return {array}                   List of objects describing the request to the server.
 *
 */
function buildRequest(validBidRequests, bidderRequest, impressions, version) {
  const userEids = [];

  // Always use secure HTTPS protocol.
  let baseUrl = SECURE_BID_URL;

  // Dict for identity partners already populated from prebid
  let seenIdPartners = {};

  // Get ids from Prebid User ID Modules
  const userId = validBidRequests[0].userId;
  if (userId && typeof userId === 'object') {
    if (userId.idl_env) {
      addUserEids(userEids, seenIdPartners, userId.idl_env, 'liveramp.com', 'LiveRampIp', 'idl');
    }
  }

  // RTI ids will be included in the bid request if the function getIdentityInfo() is loaded
  // and if the data for the partner exist
  if (window.headertag && typeof window.headertag.getIdentityInfo === 'function') {
    let identityInfo = window.headertag.getIdentityInfo();
    if (identityInfo && typeof identityInfo === 'object') {
      for (const partnerName in identityInfo) {
        if (identityInfo.hasOwnProperty(partnerName)) {
          // check if not already populated by prebid cache
          if (!seenIdPartners.hasOwnProperty(partnerName)) {
            let response = identityInfo[partnerName];
            if (!response.responsePending && response.data && typeof response.data === 'object' && Object.keys(response.data).length) {
              userEids.push(response.data);
            }
          }
        }
      }
    }
  }
  const r = {};

  // Since bidderRequestId are the same for different bid request, just use the first one.
  r.id = validBidRequests[0].bidderRequestId;

  r.site = {};
  r.ext = {};
  r.ext.source = 'prebid';
  r.ext.ixdiag = {};

  // getting ixdiags for adunits of the video, outstream & multi format (MF) style
  let ixdiag = buildIXDiag(validBidRequests);
  for (var key in ixdiag) {
    r.ext.ixdiag[key] = ixdiag[key];
  }

  // Get cached errors stored in LocalStorage
  const cachedErrors = getCachedErrors();

  if (cachedErrors) {
    r.ext.ixdiag.err = cachedErrors;
  }

  // if an schain is provided, send it along
  if (validBidRequests[0].schain) {
    r.source = {
      ext: {
        schain: validBidRequests[0].schain
      }
    };
  }

  if (userEids.length > 0) {
    r.user = {};
    r.user.eids = userEids;
  }

  if (document.referrer && document.referrer !== '') {
    r.site.ref = document.referrer;
  }

  // Apply GDPR information to the request if GDPR is enabled.
  if (bidderRequest) {
    if (bidderRequest.gdprConsent) {
      const gdprConsent = bidderRequest.gdprConsent;

      if (gdprConsent.hasOwnProperty('gdprApplies')) {
        r.regs = {
          ext: {
            gdpr: gdprConsent.gdprApplies ? 1 : 0
          }
        };
      }

      if (gdprConsent.hasOwnProperty('consentString')) {
        r.user = r.user || {};
        r.user.ext = {
          consent: gdprConsent.consentString || ''
        };
      }
    }

    if (bidderRequest.uspConsent) {
      utils.deepSetValue(r, 'regs.ext.us_privacy', bidderRequest.uspConsent);
    }

    if (bidderRequest.refererInfo) {
      r.site.page = bidderRequest.refererInfo.referer;
    }
  }

  const payload = {};

  // Parse additional runtime configs.
  const bidderCode = (bidderRequest && bidderRequest.bidderCode) || 'ix';
  const otherIxConfig = config.getConfig(bidderCode);
  if (otherIxConfig) {
    // Append firstPartyData to r.site.page if firstPartyData exists.
    if (typeof otherIxConfig.firstPartyData === 'object') {
      const firstPartyData = otherIxConfig.firstPartyData;
      let firstPartyString = '?';
      for (const key in firstPartyData) {
        if (firstPartyData.hasOwnProperty(key)) {
          firstPartyString += `${encodeURIComponent(key)}=${encodeURIComponent(firstPartyData[key])}&`;
        }
      }
      firstPartyString = firstPartyString.slice(0, -1);

      r.site.page += firstPartyString;
    }

    // Create t in payload if timeout is configured.
    if (typeof otherIxConfig.timeout === 'number') {
      payload.t = otherIxConfig.timeout;
    }

    if (typeof otherIxConfig.detectMissingSizes === 'boolean') {
      r.ext.ixdiag.dms = otherIxConfig.detectMissingSizes;
    } else {
      r.ext.ixdiag.dms = true;
    }
  }

  // Use the siteId in the first bid request as the main siteId.
  payload.s = validBidRequests[0].params.siteId;
  payload.v = version;
  payload.ac = 'j';
  payload.sd = 1;
  if (version === VIDEO_ENDPOINT_VERSION) {
    payload.nf = 1;
  }

  const requests = [];

  const request = {
    method: 'GET',
    url: baseUrl,
    data: payload
  };

  const BASE_REQ_SIZE = new Blob([`${request.url}${utils.parseQueryStringParameters({ ...request.data, r: JSON.stringify(r) })}`]).size;
  let currReqSize = BASE_REQ_SIZE;

  const MAX_REQ_SIZE = 8000;
  const MAX_REQ_LIMIT = 4;
  let sn = 0;
  let msi = 0;
  let msd = 0;
  r.ext.ixdiag.msd = 0;
  r.ext.ixdiag.msi = 0;
  r.imp = [];
  let i = 0;
  const transactionIds = Object.keys(impressions);
  let currMissingImps = [];

  while (i < transactionIds.length && requests.length < MAX_REQ_LIMIT) {
    if (impressions[transactionIds[i]].hasOwnProperty('missingCount')) {
      msd = impressions[transactionIds[i]].missingCount;
    }

    trimImpressions(impressions[transactionIds[i]], MAX_REQ_SIZE - BASE_REQ_SIZE);

    if (impressions[transactionIds[i]].hasOwnProperty('missingImps')) {
      msi = impressions[transactionIds[i]].missingImps.length;
    }

    let currImpsSize = new Blob([encodeURIComponent(JSON.stringify(impressions[transactionIds[i]]))]).size;
    currReqSize += currImpsSize;
    if (currReqSize < MAX_REQ_SIZE) {
      // pushing ix configured sizes first
      r.imp.push(...impressions[transactionIds[i]].ixImps);
      // update msd msi
      r.ext.ixdiag.msd += msd;
      r.ext.ixdiag.msi += msi;

      if (impressions[transactionIds[i]].hasOwnProperty('missingImps')) {
        currMissingImps.push(...impressions[transactionIds[i]].missingImps);
      }

      i++;
    } else {
      // pushing missing sizes after configured ones
      const clonedPayload = utils.deepClone(payload);

      r.imp.push(...currMissingImps);
      r.ext.ixdiag.sn = sn;
      clonedPayload.sn = sn;
      sn++;
      clonedPayload.r = JSON.stringify(r);

      requests.push({
        method: 'GET',
        url: baseUrl,
        data: clonedPayload
      });
      currMissingImps = [];
      currReqSize = BASE_REQ_SIZE;
      r.imp = [];
      msd = 0;
      msi = 0;
      r.ext.ixdiag.msd = 0;
      r.ext.ixdiag.msi = 0;
    }
  }

  if (currReqSize > BASE_REQ_SIZE && currReqSize < MAX_REQ_SIZE && requests.length < MAX_REQ_LIMIT) {
    const clonedPayload = utils.deepClone(payload);
    r.imp.push(...currMissingImps);

    if (requests.length > 0) {
      r.ext.ixdiag.sn = sn;
      clonedPayload.sn = sn;
    }
    clonedPayload.r = JSON.stringify(r);

    requests.push({
      method: 'GET',
      url: baseUrl,
      data: clonedPayload
    });
  }

  return requests;
}

/**
 * Calculates IX diagnostics values and packages them into an object
 *
 * @param {array} validBidRequests  The valid bid requests from prebid
 * @return {Object} IX diag values for ad units
 */
function buildIXDiag(validBidRequests) {
  var adUnitMap = validBidRequests
    .map(bidRequest => bidRequest.transactionId)
    .filter((value, index, arr) => arr.indexOf(value) === index)

  var ixdiag = {
    mfu: 0,
    bu: 0,
    iu: 0,
    nu: 0,
    ou: 0,
    allU: 0,
    ren: false
  };

  // create ad unit map and collect the required diag properties
  for (let i = 0; i < adUnitMap.length; i++) {
    var bid = validBidRequests.filter(bidRequest => bidRequest.transactionId === adUnitMap[i])[0];

    if (utils.deepAccess(bid, 'mediaTypes')) {
      if (Object.keys(bid.mediaTypes).length > 1) {
        ixdiag.mfu++;
      }

      if (utils.deepAccess(bid, 'mediaTypes.native')) {
        ixdiag.nu++;
      }

      if (utils.deepAccess(bid, 'mediaTypes.banner')) {
        ixdiag.bu++;
      }

      if (utils.deepAccess(bid, 'mediaTypes.video.context') === 'outstream') {
        ixdiag.ou++;
        // renderer only needed for outstream

        const hasRenderer = typeof (utils.deepAccess(bid, 'renderer') || utils.deepAccess(bid, 'mediaTypes.video.renderer')) === 'object';

        // if any one ad unit is missing renderer, set ren status to false in diag
        ixdiag.ren = ixdiag.ren && hasRenderer ? (utils.deepAccess(ixdiag, 'ren')) : hasRenderer;
      }

      if (utils.deepAccess(bid, 'mediaTypes.video.context') === 'instream') {
        ixdiag.iu++;
      }

      ixdiag.allU++;
    }
  }

  return ixdiag;
}

/**
 *
 * @param {Object} impressions containing ixImps and possibly missingImps
 *
 */
function trimImpressions(impressions, maxSize) {
  let currSize = new Blob([encodeURIComponent(JSON.stringify(impressions))]).size;
  if (currSize < maxSize) {
    return;
  }

  while (currSize > maxSize) {
    if (impressions.hasOwnProperty('missingImps') && impressions.missingImps.length > 0) {
      impressions.missingImps.pop();
    } else if (impressions.hasOwnProperty('ixImps') && impressions.ixImps.length > 0) {
      impressions.ixImps.pop();
    }
    currSize = new Blob([encodeURIComponent(JSON.stringify(impressions))]).size;
  }
}
/**
 *
 * @param  {array}   bannerSizeList list of banner sizes
 * @param  {array}   bannerSize the size to be removed
 * @return {boolean} true if successfully removed, false if not found
 */

function removeFromSizes(bannerSizeList, bannerSize) {
  for (let i = 0; i < bannerSizeList.length; i++) {
    if (bannerSize[0] == bannerSizeList[i][0] && bannerSize[1] == bannerSizeList[i][1]) {
      bannerSizeList.splice(i, 1);
      return true;
    }
  }
  // size not found
  return false;
}

/**
 * Updates the Object to track missing banner sizes.
 *
 * @param {object} validBidRequest    The bid request for an ad unit's with a configured size.
 * @param {object} missingBannerSizes The object containing missing banner sizes
 * @param {object} imp                The impression for the bidrequest
 */
function updateMissingSizes(validBidRequest, missingBannerSizes, imp) {
  const transactionID = validBidRequest.transactionId;
  if (missingBannerSizes.hasOwnProperty(transactionID)) {
    let currentSizeList = [];
    if (missingBannerSizes[transactionID].hasOwnProperty('missingSizes')) {
      currentSizeList = missingBannerSizes[transactionID].missingSizes;
    }
    removeFromSizes(currentSizeList, validBidRequest.params.size);
    missingBannerSizes[transactionID].missingSizes = currentSizeList;
  } else {
    // New Ad Unit
    if (utils.deepAccess(validBidRequest, 'mediaTypes.banner.sizes')) {
      let sizeList = utils.deepClone(validBidRequest.mediaTypes.banner.sizes);
      removeFromSizes(sizeList, validBidRequest.params.size);
      let newAdUnitEntry = {
        'missingSizes': sizeList,
        'impression': imp
      };
      missingBannerSizes[transactionID] = newAdUnitEntry;
    }
  }
}

/**
 * Initialize Outstream Renderer
 * @param {Object} bid
 */
function outstreamRenderer(bid) {
  bid.renderer.push(() => {
    var config = {
      width: bid.width,
      height: bid.height,
      timeout: 3000
    };

    try {
      window.IXOutstreamPlayer(bid.vastUrl, bid.adUnitCode, config);
    } catch (err) {
      utils.logError('ix outstream player failed to render', { bidder: BIDDER_CODE, code: 6 });
    }
  });
}

/**
 * Create Outstream Renderer
 * @param {string} id
 */
function createRenderer(id) {
  const renderer = Renderer.install({
    id: id,
    url: RENDERER_URL,
    loaded: false
  });

  try {
    renderer.setRender(outstreamRenderer);
  } catch (err) {
    utils.logError('ix error when calling setRender on renderer', { bidder: BIDDER_CODE, code: 7 });
  }

  return renderer;
}

/**
 *
 * @param  {object} imp      Impression object to be modified
 * @param  {array}  newSize  The new size to be applied
 * @return {object} newImp   Updated impression object
 */
function createMissingBannerImp(imp, newSize) {
  const newImp = utils.deepClone(imp);
  newImp.ext.sid = `${newSize[0]}x${newSize[1]}`;
  newImp.banner.w = newSize[0];
  newImp.banner.h = newSize[1];
  return newImp;
}

/**
 * Error Event handler that receives type and arguments in a data object.
 * @param {Object} data
 */
function errorEventsHandler(data) {
  if (storage.localStorageIsEnabled()) {
    let currentStorage;

    try {
      currentStorage = JSON.parse(storage.getDataFromLocalStorage('ixdiag')) || {};
    } catch (e) {
      utils.logWarn('ix can not read ixdiag from localStorage.');
    }

    Object.keys(currentStorage).map(function (errorDate) {
      var date = new Date(errorDate);

      if (date.setDate(date.getDate() + 7) - new Date() < 0) {
        delete currentStorage[errorDate]
      }
    });

    if (data.type === 'ERROR' && utils.deepAccess(data.arguments[1], 'bidder') === BIDDER_CODE) {
      const today = new Date().toISOString().slice(0, 10);

      try {
        const errorCode = data.arguments[1].code;

        if (errorCode) {
          if (!currentStorage.hasOwnProperty(today)) {
            currentStorage[today] = {};
          }

          if (!currentStorage[today].hasOwnProperty(errorCode) || typeof currentStorage[today][errorCode] !== 'number') {
            currentStorage[today][errorCode] = 0;
          }

          currentStorage[today][errorCode]++;

          storage.setDataInLocalStorage('ixdiag', JSON.stringify(currentStorage));
        };
      } catch (e) {
        utils.logWarn('ix can not save ixdiag in localStorage.');
      }
    }
  }
}

/**
 * Get ixdiag stored in LocalStorage and format to be added to request payload
 * @returns {Object} Object with error codes and counts
 */
function getCachedErrors() {
  if (storage.localStorageIsEnabled()) {
    const errors = {};

    try {
      let currentStorage = JSON.parse(storage.getDataFromLocalStorage('ixdiag')) || {};
      Object.keys(currentStorage).forEach((date) => {
        Object.keys(currentStorage[date]).forEach((code) => {
          if (typeof currentStorage[date][code] === 'number') {
            errors[code] = (errors[code] && typeof errors[code] === 'number')
              ? errors[code] + currentStorage[date][code]
              : currentStorage[date][code];
          }
        });
      });

      return errors;
    } catch (e) {
      utils.logError('ix can not read ixdiag from localStorage.');
    }
  }

  return null;
}

export const spec = {

  code: BIDDER_CODE,
  gvlid: GVLID,
  supportedMediaTypes: SUPPORTED_AD_TYPES,

  /**
   * Determines whether or not the given bid request is valid.
   *
   * @param  {object}  bid The bid to validate.
   * @return {boolean}     True if this is a valid bid, and false otherwise.
   */
  isBidRequestValid: function (bid) {
    // This will push a handler for each time this function is called
    if (!hasRegisteredHandler) {
      events.on(EVENTS.AUCTION_DEBUG, errorEventsHandler);
      events.on(EVENTS.AD_RENDER_FAILED, errorEventsHandler);
      hasRegisteredHandler = true;
    }

    const paramsVideoRef = utils.deepAccess(bid, 'params.video');
    const paramsSize = utils.deepAccess(bid, 'params.size');
    const mediaTypeBannerSizes = utils.deepAccess(bid, 'mediaTypes.banner.sizes');
    const mediaTypeVideoRef = utils.deepAccess(bid, 'mediaTypes.video');
    const mediaTypeVideoPlayerSize = utils.deepAccess(bid, 'mediaTypes.video.playerSize');
    const hasBidFloor = bid.params.hasOwnProperty('bidFloor');
    const hasBidFloorCur = bid.params.hasOwnProperty('bidFloorCur');

    if (!isValidSize(bid.params.size)) {
      utils.logError('ix bidder params: bid size has invalid format.', { bidder: BIDDER_CODE, code: 1 });
      return false;
    }

    if (bid.hasOwnProperty('mediaType') && !(utils.contains(SUPPORTED_AD_TYPES, bid.mediaType))) {
      utils.logWarn('ix bidder params: media type is not supported.');
      return false;
    }

    if (bid.hasOwnProperty('mediaTypes') && !(mediaTypeBannerSizes || mediaTypeVideoPlayerSize)) {
      utils.logWarn('ix bidder params: mediaTypes is missing sizes.');
      return false;
    }

    if (!includesSize(bid.sizes, paramsSize) && !((mediaTypeVideoPlayerSize && includesSize(mediaTypeVideoPlayerSize, paramsSize)) ||
     (mediaTypeBannerSizes && includesSize(mediaTypeBannerSizes, paramsSize)))) {
      utils.logError('ix bidder params: bid size is not included in ad unit sizes or player size.', { bidder: BIDDER_CODE, code: 2 });
      return false;
    }

    if (mediaTypeVideoRef && paramsVideoRef) {
      const requiredIXParams = ['mimes', 'minduration', 'maxduration', 'protocols'];
      let isParamsLevelValid = true;
      for (let property of requiredIXParams) {
        if (!mediaTypeVideoRef.hasOwnProperty(property) && !paramsVideoRef.hasOwnProperty(property)) {
          const isProtocolsValid = (property === 'protocols' && (mediaTypeVideoRef.hasOwnProperty('protocol') || paramsVideoRef.hasOwnProperty('protocol')));
          if (isProtocolsValid) {
            continue;
          }
          utils.logError('ix bidder params: ' + property + ' is not included in either the adunit or params level', { bidder: BIDDER_CODE, code: 3 });
          isParamsLevelValid = false;
        }
      }

      if (!isParamsLevelValid) {
        return false;
      }
    }

    if (typeof bid.params.siteId !== 'string' && typeof bid.params.siteId !== 'number') {
      utils.logError('ix bidder params: siteId must be string or number value.', { bidder: BIDDER_CODE, code: 4 });
      return false;
    }

    if (hasBidFloor || hasBidFloorCur) {
      if (!(hasBidFloor && hasBidFloorCur && isValidBidFloorParams(bid.params.bidFloor, bid.params.bidFloorCur))) {
        utils.logError('ix bidder params: bidFloor / bidFloorCur parameter has invalid format.', { bidder: BIDDER_CODE, code: 5 });
        return false;
      }
    }

    return true;
  },

  /**
   * Make a server request from the list of BidRequests.
   *
   * @param  {array}  validBidRequests A list of valid bid request config objects.
   * @param  {object} bidderRequest    A object contains bids and other info like gdprConsent.
   * @return {object}                  Info describing the request to the server.
   */
  buildRequests: function (validBidRequests, bidderRequest) {
    let reqs = [];
    let bannerImps = {};
    let videoImps = {};
    let validBidRequest = null;

    // To capture the missing sizes i.e not configured for ix
    let missingBannerSizes = {};

    const DEFAULT_IX_CONFIG = {
      detectMissingSizes: true,
    };

    const ixConfig = { ...DEFAULT_IX_CONFIG, ...config.getConfig('ix') };

    for (let i = 0; i < validBidRequests.length; i++) {
      validBidRequest = validBidRequests[i];

      if (validBidRequest.mediaType === VIDEO || utils.deepAccess(validBidRequest, 'mediaTypes.video')) {
        if (validBidRequest.mediaType === VIDEO || includesSize(validBidRequest.mediaTypes.video.playerSize, validBidRequest.params.size)) {
          if (!videoImps.hasOwnProperty(validBidRequest.transactionId)) {
            videoImps[validBidRequest.transactionId] = {};
          }
          if (!videoImps[validBidRequest.transactionId].hasOwnProperty('ixImps')) {
            videoImps[validBidRequest.transactionId].ixImps = [];
          }

          videoImps[validBidRequest.transactionId].ixImps.push(bidToVideoImp(validBidRequest));
        }
      }
      if (validBidRequest.mediaType === BANNER ||
        (utils.deepAccess(validBidRequest, 'mediaTypes.banner') && includesSize(utils.deepAccess(validBidRequest, 'mediaTypes.banner.sizes'), validBidRequest.params.size)) ||
        (!validBidRequest.mediaType && !validBidRequest.mediaTypes)) {
        let imp = bidToBannerImp(validBidRequest);

        if (!bannerImps.hasOwnProperty(validBidRequest.transactionId)) {
          bannerImps[validBidRequest.transactionId] = {};
        }
        if (!bannerImps[validBidRequest.transactionId].hasOwnProperty('ixImps')) {
          bannerImps[validBidRequest.transactionId].ixImps = []
        }
        bannerImps[validBidRequest.transactionId].ixImps.push(imp);
        if (ixConfig.hasOwnProperty('detectMissingSizes') && ixConfig.detectMissingSizes) {
          updateMissingSizes(validBidRequest, missingBannerSizes, imp);
        }
      }
    }

    // Finding the missing banner sizes, and making impressions for them
    for (var transactionId in missingBannerSizes) {
      if (missingBannerSizes.hasOwnProperty(transactionId)) {
        let missingSizes = missingBannerSizes[transactionId].missingSizes;

        if (!bannerImps.hasOwnProperty(transactionId)) {
          bannerImps[transactionId] = {};
        }
        if (!bannerImps[transactionId].hasOwnProperty('missingImps')) {
          bannerImps[transactionId].missingImps = [];
          bannerImps[transactionId].missingCount = 0;
        }

        let origImp = missingBannerSizes[transactionId].impression;
        for (let i = 0; i < missingSizes.length; i++) {
          let newImp = createMissingBannerImp(origImp, missingSizes[i]);
          bannerImps[transactionId].missingImps.push(newImp);
          bannerImps[transactionId].missingCount++;
        }
      }
    }

    if (Object.keys(bannerImps).length > 0) {
      reqs.push(...buildRequest(validBidRequests, bidderRequest, bannerImps, BANNER_ENDPOINT_VERSION));
    }
    if (Object.keys(videoImps).length > 0) {
      reqs.push(...buildRequest(validBidRequests, bidderRequest, videoImps, VIDEO_ENDPOINT_VERSION));
    }

    return reqs;
  },

  /**
   * Unpack the response from the server into a list of bids.
   *
   * @param  {object} serverResponse A successful response from the server.
   * @param  {object} bidderRequest  The bid request sent to the server.
   * @return {array}                 An array of bids which were nested inside the server.
   */
  interpretResponse: function (serverResponse, bidderRequest) {
    const bids = [];
    let bid = null;

    if (!serverResponse.hasOwnProperty('body') || !serverResponse.body.hasOwnProperty('seatbid')) {
      return bids;
    }

    const responseBody = serverResponse.body;
    const seatbid = responseBody.seatbid;
    for (let i = 0; i < seatbid.length; i++) {
      if (!seatbid[i].hasOwnProperty('bid')) {
        continue;
      }

      // Transform rawBid in bid response to the format that will be accepted by prebid.
      const innerBids = seatbid[i].bid;
      let requestBid = JSON.parse(bidderRequest.data.r);

      for (let j = 0; j < innerBids.length; j++) {
        const bidRequest = getBidRequest(innerBids[j].impid, requestBid.imp);
        bid = parseBid(innerBids[j], responseBody.cur, bidRequest);
        bids.push(bid);
      }

      if (requestBid.ext.ixdiag.hasOwnProperty('err')) {
        if (storage.localStorageIsEnabled()) {
          try {
            storage.removeDataFromLocalStorage('ixdiag');
          } catch (e) {
            utils.logError('ix can not clear ixdiag from localStorage.');
          }
        }
      }
    }

    return bids;
  },

  /**
   * Covert bid param types for S2S
   * @param {Object} params bid params
   * @param {Boolean} isOpenRtb boolean to check openrtb2 protocol
   * @return {Object} params bid params
   */
  transformBidParams: function (params, isOpenRtb) {
    return utils.convertTypes({
      'siteID': 'number'
    }, params);
  },

  /**
   * Determine which user syncs should occur
   * @param {object} syncOptions
   * @param {array} serverResponses
   * @returns {array} User sync pixels
   */
  getUserSyncs: function (syncOptions, serverResponses) {
    return (syncOptions.iframeEnabled) ? [{
      type: 'iframe',
      url: USER_SYNC_URL
    }] : [];
  }
};

registerBidder(spec);
