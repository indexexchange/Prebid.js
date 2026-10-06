import { expect } from 'chai';
import sinon from 'sinon';
import {
  applyFloors,
  consolidateLegacyBannerImpressions,
  FEATURE_TOGGLES,
  getIXDiagVersion,
  getOrtbConverterState,
  storage
} from '../../../libraries/ixUtils/ixUtils.js';
import { config } from '../../../src/config.js';
import '../../../modules/priceFloors.js';
import '../../../modules/schain.js';
import { FEATURE_TOGGLES as ADAPTER_FEATURE_TOGGLES, isOrtbConverterRequest, spec } from '../../../modules/ixBidAdapter.js';

// One sandbox for the file (works with the sinon version shipped by Prebid 9)
const ixSandbox = sinon.createSandbox();

describe('IX ORTB converter regression coverage', function () {
  afterEach(function () {
    ixSandbox.restore();
    FEATURE_TOGGLES.featureToggles = {};
  });

  describe('shared feature-toggle state', function () {
    it('uses the exact same feature-toggle manager in ixBidAdapter and ixUtils', function () {
      expect(ADAPTER_FEATURE_TOGGLES).to.equal(FEATURE_TOGGLES);
    });

    it('keeps response feature-toggle changes in memory when localStorage is unavailable', function () {
      ixSandbox.stub(storage, 'localStorageIsEnabled').returns(false);

      FEATURE_TOGGLES.setFeatureToggles({
        body: { ext: { features: { pbjs_enable_ortbconverter: { activated: true } } } }
      });
      expect(ADAPTER_FEATURE_TOGGLES.isFeatureEnabled('pbjs_enable_ortbconverter')).to.equal(true);

      FEATURE_TOGGLES.setFeatureToggles({
        body: { ext: { features: { pbjs_enable_ortbconverter: { activated: false } } } }
      });
      expect(ADAPTER_FEATURE_TOGGLES.isFeatureEnabled('pbjs_enable_ortbconverter')).to.equal(false);
      expect(FEATURE_TOGGLES.hasFeature('pbjs_enable_ortbconverter')).to.equal(true);
    });
  });

  describe('ixdiag cohort version', function () {
    it('reports default when the ORTB converter feature has not been assigned', function () {
      FEATURE_TOGGLES.featureToggles = {};
      expect(getIXDiagVersion('11.13.0')).to.equal('11.13.0-ortb-default-2');
    });

    it('reports disabled for an explicit control assignment', function () {
      FEATURE_TOGGLES.featureToggles = {
        features: { pbjs_enable_ortbconverter: { activated: false } }
      };
      expect(getIXDiagVersion('11.13.0')).to.equal('11.13.0-ortb-disabled-2');
    });

    it('reports enabled for an explicit treatment assignment', function () {
      FEATURE_TOGGLES.featureToggles = {
        features: { pbjs_enable_ortbconverter: { activated: true } }
      };
      expect(getIXDiagVersion('11.13.0')).to.equal('11.13.0-ortb-enabled-2');
    });

    it('keeps the version tied to the request-build snapshot after the global FT flips', function () {
      FEATURE_TOGGLES.featureToggles = {
        features: { pbjs_enable_ortbconverter: { activated: true } }
      };
      const requestState = getOrtbConverterState();

      FEATURE_TOGGLES.featureToggles = {
        features: { pbjs_enable_ortbconverter: { activated: false } }
      };

      expect(requestState.enabled).to.equal(true);
      expect(getIXDiagVersion('11.13.0', requestState)).to.equal('11.13.0-ortb-enabled-2');
      expect(getIXDiagVersion('11.13.0')).to.equal('11.13.0-ortb-disabled-2');
    });
  });

  describe('request-scoped response parser selection', function () {
    it('keeps an ORTB-built request on the ORTB parser after the global FT flips off', function () {
      const request = { ixOrtbConverter: true };
      FEATURE_TOGGLES.featureToggles = {
        features: { pbjs_enable_ortbconverter: { activated: false } }
      };

      expect(FEATURE_TOGGLES.isFeatureEnabled('pbjs_enable_ortbconverter')).to.equal(false);
      expect(isOrtbConverterRequest(request)).to.equal(true);
    });

    it('keeps a legacy-built request on the legacy parser after the global FT flips on', function () {
      const request = { ixOrtbConverter: false };
      FEATURE_TOGGLES.featureToggles = {
        features: { pbjs_enable_ortbconverter: { activated: true } }
      };

      expect(FEATURE_TOGGLES.isFeatureEnabled('pbjs_enable_ortbconverter')).to.equal(true);
      expect(isOrtbConverterRequest(request)).to.equal(false);
    });
  });

  describe('legacy banner consolidation', function () {
    it('collapses size-specific banner entries into one logical impression in IX order', function () {
      const sizes = [[1, 1], [320, 50], [300, 50], [320, 100], [300, 250], [250, 250]];
      const configured = [[320, 50], [300, 50], [320, 100], [300, 250], [250, 250]];
      const bidRequests = configured.map((size, index) => ({
        bidId: `bid-${index + 1}`,
        adUnitCode: 'slot-1',
        params: { size, siteId: 1000 + index, id: `sid-${index + 1}` },
        mediaTypes: { banner: { sizes } },
        ortb2Imp: {
          ext: {
            tid: 'publisher-tid',
            gpid: '/gpid/slot-1',
            data: { adserver: { adslot: '/gam/slot-1' } }
          }
        }
      }));
      const request = {
        imp: bidRequests.map((bid) => ({
          id: bid.bidId,
          ext: { siteID: String(bid.params.siteId), sid: bid.params.id },
          banner: { format: sizes.map(([w, h]) => ({ w, h, ext: { siteID: String(bid.params.siteId) } })) }
        }))
      };

      consolidateLegacyBannerImpressions(request, bidRequests);

      expect(request.imp).to.have.length(1);
      expect(request.imp[0].id).to.equal('bid-1');
      expect(request.imp[0].ext.siteID).to.equal(undefined);
      expect(request.imp[0].ext.sid).to.equal('sid-5');
      expect(request.imp[0].banner.format.map(({ w, h }) => [w, h])).to.deep.equal([
        [320, 50], [300, 50], [320, 100], [300, 250], [250, 250], [1, 1]
      ]);
      expect(request.imp[0].banner.format.slice(0, 5).map((format) => format.ext.siteID)).to.deep.equal([
        '1000', '1001', '1002', '1003', '1004'
      ]);
      expect(request.imp[0].banner.format[5].ext.siteID).to.equal('1000');
    });

    it('without a module imp floor, uses the lowest format floor for imp.bidfloor and keeps per-size floors', function () {
      const bidRequests = [
        {
          bidId: 'bid-a',
          adUnitCode: 'slot-floor',
          params: { size: [300, 250], siteId: 1 },
          mediaTypes: { banner: { sizes: [[300, 250], [320, 50]] } },
          getFloor: ({ size }) => ({ floor: size[0] === 300 ? 1.10 : 0.25, currency: 'USD' })
        },
        {
          bidId: 'bid-b',
          adUnitCode: 'slot-floor',
          params: { size: [320, 50], siteId: 2 },
          mediaTypes: { banner: { sizes: [[300, 250], [320, 50]] } },
          getFloor: ({ size }) => ({ floor: size[0] === 300 ? 1.10 : 0.25, currency: 'USD' })
        }
      ];
      const request = {
        imp: [
          { id: 'bid-a', banner: { format: [{ w: 300, h: 250 }, { w: 320, h: 50 }] } },
          { id: 'bid-b', banner: { format: [{ w: 300, h: 250 }, { w: 320, h: 50 }] } }
        ]
      };
      request.imp.forEach((imp, i) => applyFloors(imp, bidRequests[i]));

      consolidateLegacyBannerImpressions(request, bidRequests);

      expect(request.imp).to.have.length(1);
      expect(request.imp[0].bidfloor).to.equal(0.25);
      expect(request.imp[0].bidfloorcur).to.equal('USD');
      expect(request.imp[0].banner.format[0].ext.bidfloor).to.equal(1.10);
      expect(request.imp[0].banner.format[1].ext.bidfloor).to.equal(0.25);
    });

    it('does not collapse native or video impressions that share the banner adUnitCode', function () {
      const bidRequests = [
        {
          bidId: 'banner-1',
          adUnitCode: 'slot-mixed',
          params: { size: [300, 250], siteId: 1 },
          mediaTypes: { banner: { sizes: [[300, 250]] } }
        },
        {
          bidId: 'native-1',
          adUnitCode: 'slot-mixed',
          params: { siteId: 1 },
          mediaTypes: { native: {} }
        }
      ];
      const request = {
        imp: [
          { id: 'banner-1', banner: { format: [{ w: 300, h: 250 }] } },
          { id: 'native-1', native: { request: '{}' } }
        ]
      };

      consolidateLegacyBannerImpressions(request, bidRequests);

      expect(request.imp).to.have.length(2);
      expect(request.imp.map((imp) => imp.id)).to.deep.equal(['banner-1', 'native-1']);
    });
  });

  describe('legacy banner consolidation edge cases', function () {
    function bannerBid(id, size, { adUnitCode = 'slot', tid = 'tid-1', sizes = [[300, 250], [300, 600]] } = {}) {
      return {
        bidId: id,
        adUnitCode,
        params: { siteId: '123', size },
        mediaTypes: { banner: { sizes } },
        ortb2Imp: { ext: { tid } }
      };
    }
    function bannerImp(id) {
      return { id, banner: { format: [{ w: 300, h: 250 }, { w: 300, h: 600 }] } };
    }

    it('groups by adUnitCode like Legacy, regardless of transaction id', function () {
      const bids = [bannerBid('a', [300, 250], { tid: 'tid-a' }), bannerBid('b', [300, 600], { tid: 'tid-b' })];
      const request = { imp: [bannerImp('a'), bannerImp('b')] };

      consolidateLegacyBannerImpressions(request, bids);

      expect(request.imp.map((imp) => imp.id)).to.deep.equal(['a']);
      expect(request.imp[0].banner.format.map((f) => `${f.w}x${f.h}`)).to.deep.equal(['300x250', '300x600']);
    });

    it('groups entries without transaction ids (enableTIDs off) by adUnitCode', function () {
      const bids = [bannerBid('a', [300, 250]), bannerBid('b', [300, 600])];
      bids.forEach((b) => { delete b.ortb2Imp; });
      const request = { imp: [bannerImp('a'), bannerImp('b')] };

      consolidateLegacyBannerImpressions(request, bids);

      expect(request.imp).to.have.length(1);
    });

    it('keeps different ad unit codes as separate imps', function () {
      const bids = [bannerBid('a', [300, 250], { adUnitCode: 'top' }), bannerBid('b', [300, 250], { adUnitCode: 'bottom' })];
      const request = { imp: [bannerImp('a'), bannerImp('b')] };

      consolidateLegacyBannerImpressions(request, bids);

      expect(request.imp.map((imp) => imp.id)).to.deep.equal(['a', 'b']);
    });

    it('ignores an IX entry whose params.size is not one of the ad unit sizes (Legacy behaviour)', function () {
      const bids = [bannerBid('a', [300, 600]), bannerBid('b', [160, 600]), bannerBid('c', [300, 250])];
      const request = { imp: [bannerImp('a'), bannerImp('b'), bannerImp('c')] };

      consolidateLegacyBannerImpressions(request, bids);

      expect(request.imp).to.have.length(1);
      expect(request.imp[0].banner.format.map((f) => `${f.w}x${f.h}`)).to.deep.equal(['300x600', '300x250']);
    });
  });

  describe('video/native floors', function () {
    const getFloor = () => ({ floor: 2.5, currency: 'USD' });
    const VIDEO_MT = { mimes: ['video/mp4'], protocols: [2], minduration: 1, maxduration: 30, playerSize: [[640, 480]] };

    function run(imp, mediaTypes) {
      const bidRequest = { bidId: imp.id, adUnitCode: imp.id, getFloor, params: {}, mediaTypes };
      const request = { imp: [imp] };
      applyFloors(imp, bidRequest);
      consolidateLegacyBannerImpressions(request, [bidRequest]);
      return request.imp[0];
    }

    it('fills the video floor and imp.bidfloor for a video-only imp', function () {
      const imp = run({ id: 'v', video: { w: 640, h: 480 } }, { video: VIDEO_MT });
      expect(imp.video.ext).to.include({ bidfloor: 2.5, bidfloorcur: 'USD' });
      expect(imp.bidfloor).to.equal(2.5);
      expect(imp.bidfloorcur).to.equal('USD');
    });

    it('fills the native floor and imp.bidfloor for a native-only imp', function () {
      const imp = run({ id: 'n', native: { request: '{}' } }, { native: {} });
      expect(imp.native.ext).to.include({ bidfloor: 2.5, bidfloorcur: 'USD' });
      expect(imp.bidfloor).to.equal(2.5);
    });

    it('keeps an imp.bidfloor set by the priceFloors module', function () {
      const imp = run({ id: 'v', bidfloor: 1, bidfloorcur: 'USD', video: { w: 640, h: 480 } }, { video: VIDEO_MT });
      expect(imp.bidfloor).to.equal(1);
      expect(imp.video.ext.bidfloor).to.equal(2.5);
    });

    it('replaces a non-finite imp.bidfloor with the lowest part floor', function () {
      const imp = run({ id: 'v', bidfloor: NaN, bidfloorcur: 'USD', video: { w: 640, h: 480 } }, { video: VIDEO_MT });
      expect(imp.bidfloor).to.equal(2.5);
      expect(imp.bidfloorcur).to.equal('USD');
    });

    it('does not price a video part that will not be sent', function () {
      const imp = { id: 'v', video: { w: 640, h: 480 } };
      applyFloors(imp, { getFloor, params: {}, mediaTypes: { video: { playerSize: [[640, 480]] } } });
      expect(imp.video.ext).to.equal(undefined);
    });
  });

  describe('response routing end-to-end (spec.buildRequests -> spec.interpretResponse)', function () {
    const ORTB = 'pbjs_enable_ortbconverter';
    const bidderRequest = { refererInfo: { page: 'https://example.com' }, timeout: 1000 };
    function bid(id) {
      return {
        bidder: 'ix',
        bidId: id,
        bidderRequestId: 'breq',
        auctionId: 'auc',
        adUnitCode: 'slot',
        params: { siteId: '123', size: [300, 250] },
        mediaTypes: { banner: { sizes: [[300, 250]] } },
        ortb2Imp: { ext: { tid: 'tid-1' } }
      };
    }
    function toggle(activated) {
      FEATURE_TOGGLES.setFeatureToggles({ body: { ext: { features: { [ORTB]: { activated } } } } });
    }
    function bannerResponse(impid) {
      return { body: { id: 'r', cur: 'USD', seatbid: [{ bid: [{ id: 'b', impid, price: 150, w: 300, h: 250, adm: '<div></div>', mtype: 1 }] }] } };
    }
    function asList(out) {
      return Array.isArray(out) ? out : out.bids;
    }

    beforeEach(function () {
      ixSandbox.stub(storage, 'localStorageIsEnabled').returns(false);
    });

    it('parses a Legacy request with the Legacy parser even if the toggle flipped while it was in flight', function () {
      FEATURE_TOGGLES.featureToggles = {};
      const legacyReq = spec.buildRequests([bid('l1')], bidderRequest)[0];
      expect(legacyReq.ixOrtbConverter).to.equal(false);

      toggle(true); // another auction's response switches the page to ORTB

      const bids = asList(spec.interpretResponse(bannerResponse('l1'), legacyReq));
      expect(bids).to.have.length(1);
      expect(bids[0].requestId).to.equal('l1');
    });

    it('parses an ORTB request with the ORTB parser even if the toggle flipped while it was in flight', function () {
      toggle(true);
      const built = spec.buildRequests([bid('o1')], bidderRequest);
      const ortbReq = Array.isArray(built) ? built[0] : built;
      expect(ortbReq.ixOrtbConverter).to.equal(true);

      toggle(false);

      const bids = asList(spec.interpretResponse(bannerResponse('o1'), ortbReq));
      expect(bids).to.have.length(1);
      expect(bids[0].requestId).to.equal('o1');
      expect(bids[0].cpm).to.equal(1.5);
    });
  });

  describe('path, ext.features and ixdiag.version agree for every assignment state', function () {
    const ORTB = 'pbjs_enable_ortbconverter';
    const bidderRequest = { refererInfo: { page: 'https://example.com' }, timeout: 1000 };
    function bid(id) {
      return {
        bidder: 'ix',
        bidId: id,
        bidderRequestId: 'breq',
        auctionId: 'auc',
        adUnitCode: 'slot',
        params: { siteId: '123', size: [300, 250] },
        mediaTypes: { banner: { sizes: [[300, 250]] } },
        ortb2Imp: { ext: { tid: 'tid-1' } }
      };
    }
    function build() {
      const out = spec.buildRequests([bid('b1')], bidderRequest);
      return Array.isArray(out) ? out[0] : out;
    }

    let savedRequested;
    beforeEach(function () {
      ixSandbox.stub(storage, 'localStorageIsEnabled').returns(false);
      // FEATURE_TOGGLES is shared; ixBidAdapter_spec.js replaces this list at load time
      savedRequested = FEATURE_TOGGLES.REQUESTED_FEATURE_TOGGLES;
      FEATURE_TOGGLES.REQUESTED_FEATURE_TOGGLES = [ORTB];
    });

    afterEach(function () {
      FEATURE_TOGGLES.REQUESTED_FEATURE_TOGGLES = savedRequested;
    });

    [
      { name: 'FT absent', toggles: {}, ortb: false, activated: false, cohort: 'default' },
      { name: 'FT false', toggles: { features: { [ORTB]: { activated: false } } }, ortb: false, activated: false, cohort: 'disabled' },
      { name: 'FT true', toggles: { features: { [ORTB]: { activated: true } } }, ortb: true, activated: true, cohort: 'enabled' }
    ].forEach(({ name, toggles, ortb, activated, cohort }) => {
      it(`${name}: ${ortb ? 'ORTB' : 'Legacy'} path, activated=${activated}, -ortb-${cohort}-2`, function () {
        FEATURE_TOGGLES.featureToggles = toggles;
        const req = build();

        expect(req.ixOrtbConverter).to.equal(ortb);
        expect(req.data.ext.features[ORTB].activated).to.equal(activated);
        expect(req.data.ext.ixdiag.version).to.match(new RegExp(`-ortb-${cohort}-2$`));
      });
    });
  });

  describe('ORTB request parity with Legacy browser fields and diagnostics', function () {
    const ORTB = 'pbjs_enable_ortbconverter';
    function bannerBid(id, size, sizes) {
      return {
        bidder: 'ix',
        bidId: id,
        bidderRequestId: 'breq',
        auctionId: 'auc',
        adUnitCode: 'footer',
        params: { siteId: '123457', size },
        mediaTypes: { banner: { sizes } },
        ortb2Imp: { ext: { tid: 'tid-footer' } }
      };
    }
    function buildOrtb(bids, bidderRequest = {}) {
      FEATURE_TOGGLES.featureToggles = { features: { [ORTB]: { activated: true } } };
      const out = spec.buildRequests(bids, { refererInfo: { page: 'https://example.com' }, timeout: 1000, ...bidderRequest });
      return Array.isArray(out) ? out[0] : out;
    }

    beforeEach(function () {
      ixSandbox.stub(storage, 'localStorageIsEnabled').returns(false);
    });

    it('sets device.w/h from window.screen and keeps withCredentials', function () {
      const req = buildOrtb([bannerBid('a', [300, 250], [[300, 250]])]);

      expect(req.data.device.w).to.equal(window.screen.width);
      expect(req.data.device.h).to.equal(window.screen.height);
      expect(req.options.withCredentials).to.equal(true);
    });

    it('lets publisher/Prebid FPD site.ref win, as Legacy does', function () {
      const req = buildOrtb([bannerBid('a', [300, 250], [[300, 250]])], { ortb2: { site: { ref: 'https://referrer.example/' } } });
      expect(req.data.site.ref).to.equal('https://referrer.example/');
    });

    it('counts final logical impressions in ixdiag after consolidation', function () {
      const sizes = [[320, 50], [320, 100], [300, 50]];
      const req = buildOrtb(sizes.map((size, i) => bannerBid(`b${i}`, size, sizes)));
      const diag = req.data.ext.ixdiag;

      expect(req.data.imp).to.have.length(1);
      expect(diag.imps).to.equal(1);
      expect(diag.bu).to.equal(1);
      expect(diag.allu).to.equal(1);
    });

    it('a single IX banner bid stays one imp with its params.size first', function () {
      const req = buildOrtb([bannerBid('solo', [300, 600], [[300, 250], [300, 600]])]);
      const imp = req.data.imp[0];

      expect(req.data.imp).to.have.length(1);
      expect(imp.id).to.equal('solo');
      expect(imp.banner.format.map((f) => `${f.w}x${f.h}`)).to.deep.equal(['300x600', '300x250']);
    });
  });

  describe('multi-format ad units match Legacy', function () {
    const ORTB = 'pbjs_enable_ortbconverter';
    const FLOORS = { '300x250': 1.2, '336x280': 1.1, '728x90': 0.9, video: 4.5, native: 2.0 };
    function getFloor({ mediaType, size }) {
      if (mediaType === 'video') return { floor: FLOORS.video, currency: 'USD' };
      if (mediaType === 'native') return { floor: FLOORS.native, currency: 'USD' };
      const key = Array.isArray(size) ? `${size[0]}x${size[1]}` : '*';
      return { floor: FLOORS[key] || 0.5, currency: 'USD' };
    }
    const VIDEO = {
      context: 'outstream',
      playerSize: [[640, 360]],
      mimes: ['video/mp4'],
      protocols: [2, 3, 5, 6],
      minduration: 1,
      maxduration: 30,
      plcmt: 4
    };
    const NATIVE_REQ = { ver: '1.2', assets: [{ id: 1, required: 1, title: { len: 25 } }] };
    const BANNER_SIZES = [[300, 250], [336, 280], [728, 90]];

    function bid(id, size, { video = false, native = false, siteId = '123456' } = {}) {
      const mediaTypes = { banner: { sizes: BANNER_SIZES } };
      if (video) mediaTypes.video = { ...VIDEO };
      if (native) mediaTypes.native = { ortb: { ...NATIVE_REQ } };
      const b = {
        bidder: 'ix',
        bidId: id,
        bidderRequestId: 'breq',
        auctionId: 'auc',
        adUnitCode: 'Content_1_desktop',
        params: { siteId, size },
        mediaTypes,
        ortb2Imp: { ext: { tid: 'tid-content-1', gpid: '/1234/Content_1' } },
        getFloor
      };
      if (native) b.nativeOrtbRequest = JSON.parse(JSON.stringify(NATIVE_REQ));
      return b;
    }

    // What matters for the auction: which imps exist, their ids, media types,
    // banner size order with per-size siteID/floor, and where siteID lives.
    function shape(data) {
      return data.imp.map((imp) => ({
        id: imp.id,
        banner: imp.banner ? imp.banner.format.map((f) => `${f.w}x${f.h}@${f.ext?.bidfloor}/site:${f.ext?.siteID ?? '-'}`) : null,
        video: !!imp.video,
        native: !!imp.native,
        impSiteID: imp.ext?.siteID ?? null
      }));
    }

    function buildBoth(makeBids) {
      const bidderRequest = { refererInfo: { page: 'https://example.com' }, timeout: 1000 };
      FEATURE_TOGGLES.featureToggles = { features: { [ORTB]: { activated: false } } };
      const legacy = spec.buildRequests(makeBids(), bidderRequest)[0];
      FEATURE_TOGGLES.featureToggles = { features: { [ORTB]: { activated: true } } };
      const out = spec.buildRequests(makeBids(), bidderRequest);
      const ortb = Array.isArray(out) ? out[0] : out;
      return { legacy: legacy.data, ortb: ortb.data };
    }

    let savedRequested;
    beforeEach(function () {
      ixSandbox.stub(storage, 'localStorageIsEnabled').returns(false);
      savedRequested = FEATURE_TOGGLES.REQUESTED_FEATURE_TOGGLES;
      FEATURE_TOGGLES.REQUESTED_FEATURE_TOGGLES = [ORTB];
    });
    afterEach(function () {
      FEATURE_TOGGLES.REQUESTED_FEATURE_TOGGLES = savedRequested;
    });

    it('banner + video with 3 IX entries: banner imp (first id) + video imp (last id), same as Legacy', function () {
      const { legacy, ortb } = buildBoth(() => [
        bid('A', [300, 250], { video: true }),
        bid('B', [336, 280], { video: true }),
        bid('C', [728, 90], { video: true })
      ]);

      expect(shape(ortb)).to.deep.equal(shape(legacy));
      expect(ortb.imp.map((imp) => imp.id)).to.deep.equal(['A', 'C']);
      expect(ortb.imp[0].video).to.equal(undefined);
      expect(ortb.imp[1].banner).to.equal(undefined);
      // the video imp keeps its own floor instead of the lowest banner floor
      expect(ortb.imp[1].bidfloor).to.equal(FLOORS.video);
    });

    if (FEATURES.NATIVE) {
      it('banner + native with 2 IX entries: banner imp + native imp, same as Legacy', function () {
        const { legacy, ortb } = buildBoth(() => [
          bid('A', [300, 250], { native: true }),
          bid('B', [728, 90], { native: true })
        ]);

        expect(shape(ortb)).to.deep.equal(shape(legacy));
        expect(ortb.imp.map((imp) => imp.id)).to.deep.equal(['A', 'B']);
        expect(ortb.imp[1].bidfloor).to.equal(FLOORS.native);
      });
    }

    if (FEATURES.NATIVE) {
      it('banner + video + native with 2 IX entries: banner imp + one video/native imp, same as Legacy', function () {
        const { legacy, ortb } = buildBoth(() => [
          bid('A', [300, 250], { video: true, native: true }),
          bid('B', [728, 90], { video: true, native: true })
        ]);

        expect(shape(ortb)).to.deep.equal(shape(legacy));
        expect(ortb.imp).to.have.length(2);
        expect(ortb.imp[1].video).to.not.equal(undefined);
        expect(ortb.imp[1].native).to.not.equal(undefined);
      });
    }

    it('banner + video with a single IX entry stays one multi-format imp, same as Legacy', function () {
      const { legacy, ortb } = buildBoth(() => [bid('A', [336, 280], { video: true })]);

      expect(shape(ortb)).to.deep.equal(shape(legacy));
      expect(ortb.imp).to.have.length(1);
      expect(ortb.imp[0].banner.format[0]).to.include({ w: 336, h: 280 });
      expect(ortb.imp[0].ext.siteID).to.equal('123456');
    });

    it('maps a video bid on the split video imp back to the last IX entry', function () {
      const bidderRequest = { refererInfo: { page: 'https://example.com' }, timeout: 1000 };
      FEATURE_TOGGLES.featureToggles = { features: { [ORTB]: { activated: true } } };
      const out = spec.buildRequests([
        bid('A', [300, 250], { video: true }),
        bid('B', [728, 90], { video: true })
      ], bidderRequest);
      const req = Array.isArray(out) ? out[0] : out;

      const body = {
        id: 'r',
        cur: 'USD',
        seatbid: [{ bid: [{ id: 'v', impid: 'B', price: 500, w: 640, h: 360, adm: '<VAST version="3.0"></VAST>', mtype: 2 }] }]
      };
      const result = spec.interpretResponse({ body }, req);
      const bids = Array.isArray(result) ? result : result.bids;

      expect(bids).to.have.length(1);
      expect(bids[0].requestId).to.equal('B');
      expect(bids[0].mediaType).to.equal('video');
      expect(bids[0].cpm).to.equal(5);
    });
  });
  describe('per-ad-unit parity with Legacy (video, native, banner sizes, GDPR)', function () {
    const ORTB = 'pbjs_enable_ortbconverter';
    const VIDEO = { context: 'instream', playerSize: [[640, 480]], mimes: ['video/mp4'], protocols: [2, 3], minduration: 5, maxduration: 30, plcmt: 1 };
    const NATIVE_REQ = { ver: '1.2', assets: [{ id: 1, required: 1, title: { len: 25 } }] };
    const SIZES = [[300, 250], [728, 90], [320, 50]];

    function ixBid(id, code, mediaTypes, params = {}) {
      const b = {
        bidder: 'ix',
        bidId: id,
        bidderRequestId: 'breq',
        auctionId: 'auc',
        adUnitCode: code,
        params: { siteId: '1000', ...params },
        mediaTypes: JSON.parse(JSON.stringify(mediaTypes)),
        ortb2Imp: { ext: { tid: `tid-${code}`, gpid: `/gpid/${code}` } }
      };
      if (mediaTypes.native) b.nativeOrtbRequest = JSON.parse(JSON.stringify(NATIVE_REQ));
      return b;
    }

    function build(enabled, bids, bidderRequest) {
      FEATURE_TOGGLES.featureToggles = { features: { [ORTB]: { activated: enabled } } };
      const out = spec.buildRequests(bids, { refererInfo: { page: 'https://example.com' }, timeout: 1000, ...bidderRequest });
      const req = Array.isArray(out) ? out[0] : out;
      return req ? req.data : null;
    }

    // Legacy is built first, then ORTB, from fresh copies of the same bids.
    function buildBoth(makeBids, bidderRequest = {}) {
      return { legacy: build(false, makeBids(), bidderRequest), ortb: build(true, makeBids(), bidderRequest) };
    }

    function shape(data) {
      if (!data) return null;
      return data.imp.map((imp) => ({
        id: imp.id,
        banner: imp.banner ? imp.banner.format.map((f) => `${f.w}x${f.h}/site:${f.ext?.siteID ?? '-'}`) : null,
        video: !!imp.video,
        native: !!imp.native,
        impSiteID: imp.ext?.siteID ?? null
      }));
    }

    let savedRequested;
    beforeEach(function () {
      ixSandbox.stub(storage, 'localStorageIsEnabled').returns(false);
      savedRequested = FEATURE_TOGGLES.REQUESTED_FEATURE_TOGGLES;
      FEATURE_TOGGLES.REQUESTED_FEATURE_TOGGLES = [ORTB];
    });
    afterEach(function () {
      FEATURE_TOGGLES.REQUESTED_FEATURE_TOGGLES = savedRequested;
    });

    if (FEATURES.VIDEO) {
      it('2 pure Video IX bids on one ad unit send 1 imp from the last entry', function () {
        const { legacy, ortb } = buildBoth(() => [
          ixBid('V1', 'video-slot', { video: VIDEO }, { siteId: '1' }),
          ixBid('V2', 'video-slot', { video: VIDEO }, { siteId: '2' })
        ]);

        expect(shape(ortb)).to.deep.equal(shape(legacy));
        expect(ortb.imp).to.have.length(1);
        expect(ortb.imp[0].id).to.equal('V2');
        expect(ortb.imp[0].ext.siteID).to.equal('2');
        expect(ortb.ext.ixdiag.imps).to.equal(1);
      });
    }

    if (FEATURES.NATIVE) {
      it('2 pure Native IX bids on one ad unit send 1 imp from the last entry', function () {
        const { legacy, ortb } = buildBoth(() => [
          ixBid('N1', 'native-slot', { native: {} }, { siteId: '1' }),
          ixBid('N2', 'native-slot', { native: {} }, { siteId: '2' })
        ]);

        expect(shape(ortb)).to.deep.equal(shape(legacy));
        expect(ortb.imp).to.have.length(1);
        expect(ortb.imp[0].id).to.equal('N2');
        expect(ortb.imp[0].ext.siteID).to.equal('2');
      });
    }

    if (FEATURES.VIDEO && FEATURES.NATIVE) {
      it('2 Video+Native IX bids without Banner send 1 multi-format imp from the last entry', function () {
        const { legacy, ortb } = buildBoth(() => [
          ixBid('X1', 'vn-slot', { video: VIDEO, native: {} }, { siteId: '1' }),
          ixBid('X2', 'vn-slot', { video: VIDEO, native: {} }, { siteId: '2' })
        ]);

        expect(shape(ortb)).to.deep.equal(shape(legacy));
        expect(ortb.imp).to.have.length(1);
        expect(ortb.imp[0].id).to.equal('X2');
        expect(ortb.imp[0].video).to.not.equal(undefined);
        expect(ortb.imp[0].native).to.not.equal(undefined);
      });
    }

    it('mixed Banner params.size / no params.size: sized entries first, imp id from the first sized entry', function () {
      const sizedFirst = buildBoth(() => [
        ixBid('B1', 'banner-slot', { banner: { sizes: SIZES } }, { siteId: '1', size: [728, 90] }),
        ixBid('B2', 'banner-slot', { banner: { sizes: SIZES } }, { siteId: '2' })
      ]);
      expect(shape(sizedFirst.ortb)).to.deep.equal(shape(sizedFirst.legacy));
      expect(shape(sizedFirst.ortb)[0].banner).to.deep.equal(['728x90/site:1', '300x250/site:1', '320x50/site:1']);
      expect(sizedFirst.ortb.imp[0].id).to.equal('B1');

      const sizedSecond = buildBoth(() => [
        ixBid('B1', 'banner-slot', { banner: { sizes: SIZES } }, { siteId: '1' }),
        ixBid('B2', 'banner-slot', { banner: { sizes: SIZES } }, { siteId: '2', size: [728, 90] })
      ]);
      expect(shape(sizedSecond.ortb)).to.deep.equal(shape(sizedSecond.legacy));
      expect(shape(sizedSecond.ortb)[0].banner).to.deep.equal(['728x90/site:2', '300x250/site:1', '320x50/site:1']);
      expect(sizedSecond.ortb.imp[0].id).to.equal('B2');
    });

    it('multiple Banner bids with no params.size send 1 imp with all ad unit sizes from the first entry', function () {
      const { legacy, ortb } = buildBoth(() => [
        ixBid('B1', 'banner-slot', { banner: { sizes: SIZES } }, { siteId: '1' }),
        ixBid('B2', 'banner-slot', { banner: { sizes: SIZES } }, { siteId: '2' })
      ]);

      expect(shape(ortb)).to.deep.equal(shape(legacy));
      expect(ortb.imp).to.have.length(1);
      expect(ortb.imp[0].id).to.equal('B1');
      expect(shape(ortb)[0].banner).to.deep.equal(['300x250/site:1', '728x90/site:1', '320x50/site:1']);
    });

    it('duplicate params.size keeps one format per IX entry, like Legacy', function () {
      const { legacy, ortb } = buildBoth(() => [
        ixBid('B1', 'banner-slot', { banner: { sizes: SIZES } }, { siteId: '1', size: [300, 250] }),
        ixBid('B2', 'banner-slot', { banner: { sizes: SIZES } }, { siteId: '2', size: [300, 250] })
      ]);

      expect(shape(ortb)).to.deep.equal(shape(legacy));
      expect(shape(ortb)[0].banner).to.deep.equal(['300x250/site:1', '300x250/site:2', '728x90/site:1', '320x50/site:1']);
    });

    if (FEATURES.VIDEO) {
      it('drops a Video part that is missing required fields, like Legacy', function () {
        const incomplete = { context: 'instream', playerSize: [[640, 480]] };

        // video-only ad unit: nothing is sent
        const videoOnly = buildBoth(() => [ixBid('V1', 'video-slot', { video: incomplete })]);
        expect(videoOnly.legacy).to.equal(null);
        expect(videoOnly.ortb).to.equal(null);

        // banner + video ad unit: only the banner part is sent
        const withBanner = buildBoth(() => [ixBid('V1', 'mf-slot', { banner: { sizes: [[300, 250]] }, video: incomplete })]);
        expect(shape(withBanner.ortb)).to.deep.equal(shape(withBanner.legacy));
        expect(withBanner.ortb.imp).to.have.length(1);
        expect(withBanner.ortb.imp[0].video).to.equal(undefined);
        expect(withBanner.ortb.imp[0].banner.format[0].ext.siteID).to.equal('1000');
      });

      it('drops a Video part with minduration > maxduration, and falls back to the earlier valid entry', function () {
        const invalid = buildBoth(() => [ixBid('V1', 'video-slot', { video: { ...VIDEO, minduration: 60, maxduration: 30 } })]);
        expect(invalid.legacy).to.equal(null);
        expect(invalid.ortb).to.equal(null);

        // params.video overrides mediaTypes.video, as in Legacy
        const lastInvalid = buildBoth(() => [
          ixBid('V1', 'video-slot', { video: VIDEO }, { siteId: '1' }),
          ixBid('V2', 'video-slot', { video: VIDEO }, { siteId: '2', video: { minduration: 90 } })
        ]);
        expect(shape(lastInvalid.ortb)).to.deep.equal(shape(lastInvalid.legacy));
        expect(lastInvalid.ortb.imp).to.have.length(1);
        expect(lastInvalid.ortb.imp[0].id).to.equal('V1');
      });
    }

    if (FEATURES.VIDEO) {
      it('removes video.plcmt outside 1-4 (or non-integer), like Legacy', function () {
        [5, 0, 2.5, '2'].forEach((plcmt) => {
          const { legacy, ortb } = buildBoth(() => [ixBid('V1', 'video-slot', { video: { ...VIDEO, plcmt } })]);
          expect(legacy.imp[0].video).to.not.have.property('plcmt');
          expect(ortb.imp[0].video, `plcmt ${plcmt}`).to.not.have.property('plcmt');
        });

        const valid = buildBoth(() => [ixBid('V1', 'video-slot', { video: { ...VIDEO, plcmt: 2 } })]);
        expect(valid.legacy.imp[0].video.plcmt).to.equal(2);
        expect(valid.ortb.imp[0].video.plcmt).to.equal(2);
      });

      it('ixdiag.imps counts ad units like Legacy, not imps on the wire', function () {
        const banner = { banner: { sizes: [[300, 250], [728, 90]] } };
        const { legacy, ortb } = buildBoth(() => [
          // 1 ad unit sent as 2 imps (banner imp + video imp)
          ixBid('A1', 'mf-slot', { ...banner, video: VIDEO }, { size: [300, 250] }),
          ixBid('A2', 'mf-slot', { ...banner, video: VIDEO }, { size: [728, 90] }),
          // a second banner ad unit
          ixBid('B1', 'banner-slot', banner),
          // an ad unit whose only part is an invalid video: dropped, not counted
          ixBid('C1', 'bad-video-slot', { video: { context: 'instream', playerSize: [[640, 480]] } })
        ]);

        expect(ortb.imp).to.have.length(3);
        expect(legacy.ext.ixdiag.imps).to.equal(2);
        expect(ortb.ext.ixdiag.imps).to.equal(legacy.ext.ixdiag.imps);
      });

      it('ixdiag tagid/adunitcode/divId come from the last ad unit in Legacy order, and usid matches', function () {
        const diag = (data) => {
          const { tagid, adunitcode, divId, usid } = data.ext.ixdiag;
          return { tagid, adunitcode, divId, usid };
        };
        // Legacy order: ad units with banner first (A, B), then video-only (V): V is last
        const multi = buildBoth(() => [
          ixBid('A1', 'unit-a', { banner: { sizes: [[300, 250]] } }, { tagId: 'tag-a' }),
          ixBid('V1', 'unit-v', { video: VIDEO }, { tagId: 'tag-v' }),
          ixBid('B1', 'unit-b', { banner: { sizes: [[300, 250]] } }, { tagId: 'tag-b' })
        ]);
        expect(diag(multi.ortb)).to.deep.equal(diag(multi.legacy));
        expect(multi.ortb.ext.ixdiag.adunitcode).to.equal('unit-v');
        expect(multi.ortb.ext.ixdiag.tagid).to.equal('tag-v');

        // single IX entry banner+video: siteID moves to imp.ext, Legacy flags usid
        const multiFormat = buildBoth(() => [ixBid('M1', 'unit-m', { banner: { sizes: [[300, 250]] }, video: VIDEO })]);
        expect(multiFormat.legacy.ext.ixdiag.usid).to.equal(true);
        expect(multiFormat.ortb.ext.ixdiag.usid).to.equal(true);
      });
    }

    it('ixdiag tagid/adunitcode come from the last banner entry of the last ad unit', function () {
      const { legacy, ortb } = buildBoth(() => [
        ixBid('A1', 'unit-a', { banner: { sizes: [[300, 250]] } }, { tagId: 'tag-a' }),
        ixBid('B1', 'unit-b', { banner: { sizes: [[300, 250]] } }, { tagId: 'tag-b1' }),
        ixBid('B2', 'unit-b', { banner: { sizes: [[300, 250]] } }, { tagId: 'tag-b2' })
      ]);
      expect(ortb.ext.ixdiag.adunitcode).to.equal(legacy.ext.ixdiag.adunitcode);
      expect(ortb.ext.ixdiag.tagid).to.equal(legacy.ext.ixdiag.tagid);
      expect(ortb.ext.ixdiag.tagid).to.equal('tag-b2');
      expect(ortb.ext.ixdiag.usid).to.equal(legacy.ext.ixdiag.usid);
      expect(ortb.ext.ixdiag.usid).to.equal(undefined);
    });

    it('a throwing getFloor() logs and still builds the request, like Legacy', function () {
      const throwing = () => { throw new Error('publisher floor function failed'); };
      const make = () => {
        const media = { banner: { sizes: [[300, 250], [728, 90]] } };
        if (FEATURES.VIDEO) media.video = VIDEO;
        const bid = ixBid('F1', 'floor-slot', media);
        bid.getFloor = throwing;
        return [bid];
      };
      let result;
      expect(() => { result = buildBoth(make); }).to.not.throw();
      expect(result.legacy.imp).to.have.length(1);
      expect(result.ortb.imp).to.have.length(1);
      expect(result.ortb.imp[0].bidfloor).to.equal(undefined);
    });

    it('documents an accepted difference: missing banner sizes use their own ad unit floor, not the first bid in the request', function () {
      const floorFor = (value) => () => ({ floor: value, currency: 'USD' });
      const make = () => {
        const first = ixBid('A1', 'unit-a', { banner: { sizes: [[300, 250]] } }, { size: [300, 250] });
        first.getFloor = floorFor(1.0);
        // unit-b: 300x250 configured, 728x90 missing
        const second = ixBid('B1', 'unit-b', { banner: { sizes: [[300, 250], [728, 90]] } }, { size: [300, 250] });
        second.getFloor = floorFor(2.0);
        return [first, second];
      };
      const { legacy, ortb } = buildBoth(make);
      const missingFloor = (data) => data.imp.find((imp) => imp.id === 'B1').banner.format
        .find((f) => f.w === 728 && f.h === 90).ext.bidfloor;

      // Legacy calls createMissingBannerImp(validBidRequests[0], ...), so unit-b's missing
      // size is priced with unit-a's floor function. The ORTB path uses unit-b's own floor.
      expect(missingFloor(legacy)).to.equal(1.0);
      expect(missingFloor(ortb)).to.equal(2.0);
    });

    it('sends addtl_consent when consentString is empty, like Legacy', function () {
      const banner = () => [ixBid('B1', 'banner-slot', { banner: { sizes: [[300, 250]] } })];
      const { legacy, ortb } = buildBoth(banner, { gdprConsent: { gdprApplies: true, consentString: '', addtlConsent: '1~7.12' } });
      const addtl = (data) => data.user?.ext?.consented_providers_settings?.addtl_consent;
      expect(addtl(legacy)).to.equal('1~7.12');
      expect(addtl(ortb)).to.equal('1~7.12');
      expect(ortb.user.ext.consent).to.equal(legacy.user.ext.consent);
    });

    it('banner metadata follows Legacy per-field rules when IX entries differ', function () {
      const { legacy, ortb } = buildBoth(() => {
        const a = ixBid('A1', 'meta-slot', { banner: { sizes: SIZES, pos: 1 } }, { siteId: '100', size: [300, 250], id: 'sid-a' });
        a.ortb2Imp = { ext: { tid: 'tid-a', gpid: '/gpid/a', data: { adserver: { adslot: '/slot/a' } } } };
        const b = ixBid('A2', 'meta-slot', { banner: { sizes: SIZES } }, { siteId: '100', size: [728, 90] });
        b.ortb2Imp = {};
        return [a, b];
      });
      // compare what is sent on the wire (Legacy keeps keys whose value is undefined)
      const pick = (data) => JSON.parse(JSON.stringify({ ext: data.imp[0].ext, pos: data.imp[0].banner.pos }));

      expect(pick(ortb)).to.deep.equal(pick(legacy));
      // sid survives a later entry without params.id; tid/gpid/adslot/pos are cleared by it; ext.data persists
      expect(ortb.imp[0].ext.sid).to.equal('sid-a');
      expect(ortb.imp[0].ext).to.not.have.any.keys('tid', 'gpid', 'dfp_ad_unit_code');
      expect(ortb.imp[0].ext.data).to.deep.equal({ adserver: { adslot: '/slot/a' } });
      expect(ortb.imp[0].banner.pos).to.equal(undefined);
    });

    it('orders imps like Legacy: ad units with banner first, then video-only, then native-only', function () {
      const make = () => {
        const bids = [];
        if (FEATURES.NATIVE) bids.push(ixBid('N1', 'native-slot', { native: {} }));
        if (FEATURES.VIDEO) bids.push(ixBid('V1', 'video-slot', { video: VIDEO }));
        bids.push(ixBid('B1', 'banner-slot', { banner: { sizes: SIZES } }));
        return bids;
      };
      const { legacy, ortb } = buildBoth(make);
      const ids = (data) => data.imp.map((imp) => imp.id);
      expect(ids(ortb)).to.deep.equal(ids(legacy));
      expect(ids(ortb)[0]).to.equal('B1');
    });

    it('prices every banner size like Legacy', function () {
      const sizes = [[1, 1], [320, 50], [300, 50], [320, 100], [300, 250], [250, 250], [336, 280]];
      const floors = { '300x250': 0.8, '336x280': 0.8, '320x50': 0.3 };
      const getFloor = ({ size }) => ({ floor: (Array.isArray(size) && floors[size.join('x')]) || 0.1, currency: 'USD' });
      const make = () => [[320, 50], [300, 250], [336, 280]].map((size, i) => {
        const bid = ixBid(`F${i}`, 'footer', { banner: { sizes } }, { size, id: `sid-${i}` });
        bid.getFloor = getFloor;
        return bid;
      });
      const { legacy, ortb } = buildBoth(make);
      const formatFloors = (data) => data.imp[0].banner.format.map((f) => [f.w, f.h, f.ext.bidfloor, f.ext.fl]);
      expect(formatFloors(ortb)).to.deep.equal(formatFloors(legacy));
    });

    it('keeps the floors Prebid sets and fills the sizes it leaves out (equal to imp.bidfloor)', function () {
      // the default floor (0.5) applies to the wildcard and to 320x50, so Prebid only writes 300x250
      const getFloor = ({ size }) => ({ floor: Array.isArray(size) && size[0] === 300 ? 1 : 0.5, currency: 'USD' });
      const make = () => {
        const bid = ixBid('B1', 'slot', { banner: { sizes: [[300, 250], [320, 50]] } }, { size: [300, 250] });
        bid.getFloor = getFloor;
        return [bid];
      };
      const { ortb } = buildBoth(make);
      expect(ortb.imp[0].bidfloor).to.equal(0.5);
      expect(ortb.imp[0].banner.format.map((f) => f.ext.bidfloor)).to.deep.equal([1, 0.5]);
    });

    it('uses params.bidFloor for every size when there is no priceFloors floor, like Legacy', function () {
      const make = () => [[300, 250], [320, 50]].map((size, i) =>
        ixBid(`P${i}`, 'slot', { banner: { sizes: [[300, 250], [320, 50]] } }, { size, bidFloor: i ? 0.75 : 1.25, bidFloorCur: 'USD' }));
      const { legacy, ortb } = buildBoth(make);
      const formatFloors = (data) => data.imp[0].banner.format.map((f) => [f.ext.bidfloor, f.ext.fl]);
      expect(formatFloors(ortb)).to.deep.equal(formatFloors(legacy));
      expect(ortb.imp[0].bidfloor).to.equal(0.75);
    });

    it('preserves GDPR user.ext.consent and regs.ext.gdpr with or without ortb2 consent enrichment', function () {
      const gdprConsent = { gdprApplies: true, consentString: 'CONSENT-STRING', addtlConsent: '1~7.12' };
      const banner = () => [ixBid('B1', 'banner-slot', { banner: { sizes: [[300, 250]] } })];
      const pick = (data) => ({
        consent: data.user?.ext?.consent,
        addtl: data.user?.ext?.consented_providers_settings?.addtl_consent,
        gdpr: data.regs?.ext?.gdpr
      });
      const expected = { consent: 'CONSENT-STRING', addtl: '1~7.12', gdpr: 1 };

      const enriched = buildBoth(banner, {
        gdprConsent,
        ortb2: { regs: { ext: { gdpr: 1 } }, user: { ext: { consent: 'CONSENT-STRING' } } }
      });
      expect(pick(enriched.legacy)).to.deep.equal(expected);
      expect(pick(enriched.ortb)).to.deep.equal(expected);

      const notEnriched = buildBoth(banner, { gdprConsent });
      expect(pick(notEnriched.legacy)).to.deep.equal(expected);
      expect(pick(notEnriched.ortb)).to.deep.equal(expected);

      const notApplicable = buildBoth(banner, { gdprConsent: { gdprApplies: false, consentString: '' } });
      expect(pick(notApplicable.ortb)).to.deep.equal(pick(notApplicable.legacy));
    });
  });
  describe('full-payload parity with Legacy', function () {
    const ORTB = 'pbjs_enable_ortbconverter';
    const VIDEO = { context: 'outstream', playerSize: [[640, 360]], mimes: ['video/mp4'], protocols: [2, 3], minduration: 5, maxduration: 30, plcmt: 4, api: [2] };
    const NATIVE_REQ = { ver: '1.2', assets: [{ id: 1, required: 1, title: { len: 25 } }, { id: 2, required: 1, img: { type: 3, w: 300, h: 250 } }] };
    const EIDS = [{ source: 'adserver.org', uids: [{ id: 'tdid', atype: 1, ext: { rtiPartner: 'TDID' } }] }, { source: 'pubcid.org', uids: [{ id: 'pub', atype: 1 }] }];
    const FLOORS = { '300x250': 0.5, '728x90': 0.4, '320x50': 0.2, '300x600': 0.9, '1x1': 0.05, video: 3.0, native: 1.0 };
    const getFloor = ({ mediaType, size }) => {
      if (mediaType === 'video') return { floor: FLOORS.video, currency: 'USD' };
      if (mediaType === 'native') return { floor: FLOORS.native, currency: 'USD' };
      return { floor: FLOORS[Array.isArray(size) ? size.join('x') : '*'] ?? 0.1, currency: 'USD' };
    };
    const ORTB2 = {
      site: { page: 'https://pub.example/article?x=1', domain: 'pub.example', ref: 'https://google.com/', publisher: { domain: 'pub.example' }, content: { language: 'en' } },
      device: { ua: 'UA', language: 'en', w: 1, h: 1, dnt: 0, sua: { mobile: 0 } },
      regs: { ext: { gdpr: 1 }, gpp: 'GPPSTRING', gpp_sid: [7] },
      user: { ext: { consent: 'CONSENT' } }
    };
    // Prebid 9 provides the supply chain on each bid (the schain module adds it to ORTB requests)
    const SCHAIN = { ver: '1.0', complete: 1, nodes: [{ asi: 'pub.example', sid: '1', hp: 1 }] };
    const BIDDER_REQUEST = {
      bidderCode: 'ix',
      auctionId: 'auc',
      bidderRequestId: 'breq',
      timeout: 1500,
      refererInfo: { page: 'https://pub.example/article?x=1', ref: 'https://google.com/', domain: 'pub.example', topmostLocation: 'https://pub.example/article?x=1', reachedTop: true },
      gdprConsent: { gdprApplies: true, consentString: 'CONSENT', addtlConsent: '1~7' },
      // uspConsent is left out on purpose: Legacy keeps it in a module-level variable that is never
      // cleared, which would leak into later Legacy user-sync tests.
      gppConsent: { gppString: 'GPPSTRING', applicableSections: [7] },
      ortb2: ORTB2
    };

    function bid(id, code, mediaTypes, params = {}, extra = {}) {
      const b = {
        bidder: 'ix',
        bidId: id,
        bidderRequestId: 'breq',
        auctionId: 'auc',
        adUnitCode: code,
        src: 'client',
        params: { siteId: '1000', ...params },
        mediaTypes: JSON.parse(JSON.stringify(mediaTypes)),
        sizes: mediaTypes.banner ? mediaTypes.banner.sizes : (mediaTypes.video ? mediaTypes.video.playerSize : []),
        ortb2Imp: { ext: { gpid: `/123/${code}`, data: { adserver: { name: 'gam', adslot: `/123/${code}` }, pbadslot: `/123/${code}` } } },
        ortb2: JSON.parse(JSON.stringify(ORTB2)),
        schain: JSON.parse(JSON.stringify(SCHAIN)),
        userIdAsEids: EIDS,
        userId: { tdid: 'tdid', pubcid: 'pub' },
        getFloor,
        ...extra
      };
      if (mediaTypes.native) b.nativeOrtbRequest = JSON.parse(JSON.stringify(NATIVE_REQ));
      return b;
    }

    const SCENARIOS = {
      'multi-size banner with one IX entry per size, two ad units': () => {
        const footerSizes = [[1, 1], [320, 50], [300, 50], [320, 100], [300, 250], [250, 250]];
        const bids = [[320, 50], [300, 50], [320, 100], [300, 250], [250, 250]].map((size, i) =>
          bid(`f${i}`, 'Footer_1_phone', { banner: { sizes: footerSizes } }, { siteId: String(1000 + i), size, id: `sid-f${i}` }));
        const sideSizes = [[300, 250], [300, 600]];
        bids.push(bid('s0', 'Sidebar_1', { banner: { sizes: sideSizes, pos: 1 } }, { siteId: '2000', size: [300, 250], id: 'sid-s0' }));
        bids.push(bid('s1', 'Sidebar_1', { banner: { sizes: sideSizes, pos: 1 } }, { siteId: '2001', size: [300, 600], id: 'sid-s1' }));
        return bids;
      },
      'banner entries with differing metadata': () => [
        bid('d1', 'meta', { banner: { sizes: [[300, 250], [728, 90]], pos: 1 } }, { size: [300, 250], id: 'sid-a' }, { ortb2Imp: { ext: { tid: 'tid-a', gpid: '/gpid/a', data: { adserver: { adslot: '/slot/a' } } } } }),
        bid('d2', 'meta', { banner: { sizes: [[300, 250], [728, 90]] } }, { size: [728, 90] }, { ortb2Imp: {} })
      ],
      'adapter floors without the floors module': () => [
        bid('a1', 'af', { banner: { sizes: [[300, 250], [728, 90]] } }, { size: [300, 250], bidFloor: 0.75, bidFloorCur: 'USD' }, { getFloor: undefined }),
        bid('a2', 'af', { banner: { sizes: [[300, 250], [728, 90]] } }, { size: [728, 90], bidFloor: 0.25, bidFloorCur: 'USD' }, { getFloor: undefined })
      ],
    };
    if (FEATURES.VIDEO && FEATURES.NATIVE) {
      SCENARIOS['mixed video-only, banner, native-only, multi-format ad units'] = () => [
        bid('v1', 'video-only', { video: VIDEO }, { tagId: 'tag-v' }),
        bid('b1', 'banner-a', { banner: { sizes: [[300, 250], [728, 90]] } }, { size: [300, 250], id: 'sid-b1', tagId: 't1' }, { ortb2Imp: { ext: { gpid: '/123/a', tid: 'tid-b1' } } }),
        bid('b2', 'banner-a', { banner: { sizes: [[300, 250], [728, 90]] } }, { size: [728, 90], tagId: 't2', bidFloor: 0.3, bidFloorCur: 'USD' }, { ortb2Imp: {} }),
        bid('n1', 'native-only', { native: {} }),
        bid('m1', 'multi', { banner: { sizes: [[300, 250], [300, 600]] }, video: VIDEO }, { size: [300, 600] }),
        bid('m2', 'multi', { banner: { sizes: [[300, 250], [300, 600]] }, video: VIDEO }, { size: [300, 250], video: { skip: 1 } }),
        bid('s1', 'single-mf', { banner: { sizes: [[300, 250]] }, video: VIDEO, native: {} })
      ];
      SCENARIOS['video and native with params.id and adapter floors'] = () => [
        bid('w1', 'vid', { video: { ...VIDEO, context: 'instream' } }, { id: 'sid-v', bidFloor: 2, bidFloorCur: 'USD' }, { getFloor: undefined }),
        bid('w2', 'nat', { native: {} }, { id: 'sid-n', tagId: 'tn' })
      ];
    }

    // Every accepted ORTB vs Legacy difference, with the reason. Anything else fails the test.
    const ACCEPTED = [
      [/^\.ext\.ixdiag\.version$/, 'cohort suffix -ortb-enabled-2 vs -ortb-disabled-2'],
      [/^\.ext\.features\.pbjs_enable_ortbconverter\.activated$/, 'reports which path built the request'],
      [/^\.ext\.ixdiag\.userIds$/, 'ORTB-only diagnostic (Prebid user ID module names); no Legacy counterpart'],
      [/^\.ext\.ixdiag\.vpd$/, 'Legacy flag is sticky across auctions; ORTB reports the current request'],
      [/^\.device\.(ua|language|dnt)$/, 'converter merges Prebid ortb2.device first-party data'],
      [/^\.imp\.[^.]+\.secure$/, 'converter default'],
      [/^\.test$/, 'converter default (0)'],
      [/^\.tmax$/, 'converter default (bidderRequest.timeout)'],
      [/^\.imp\.[^.]+\.(banner\.format\[\d+\]|video|native)\.ext\.bidfloorcur$/, 'floor currency kept next to each per-size/per-media floor'],
      [/^\.imp\.[^.]+\.bidfloor$/, 'imp.bidfloor is the lowest size floor; each size keeps its own floor on banner.format'],
      [/^\.imp\.[^.]+\.displaymanager$/, 'set on every imp with an outstream video part, including multi-format imps'],
      [/^\.imp\.[^.]+\.ext\.dfp_ad_unit_code$/, 'ad server slot sent on every imp, not only banner imps'],
      [/^\.imp\.[^.]+\.ext\.fl$/, 'floor source stays on each floor (format, video and native ext.fl)'],
      [/^\.imp\.[^.]+\.video\.playerSize$/, 'Prebid ad unit field; the player size is sent as video.w / video.h'],
    ];

    function diff(a, b, path = '', out = []) {
      if (JSON.stringify(a) === JSON.stringify(b)) return out;
      if (a && b && typeof a === 'object' && typeof b === 'object' && Array.isArray(a) === Array.isArray(b)) {
        const keys = Array.isArray(a)
          ? [...Array(Math.max(a.length, b.length)).keys()]
          : [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();
        keys.forEach((k) => diff(a[k], b[k], path + (Array.isArray(a) ? `[${k}]` : `.${k}`), out));
        return out;
      }
      out.push({ path, legacy: a, ortb: b });
      return out;
    }

    function build(enabled, bids) {
      FEATURE_TOGGLES.featureToggles = { features: { [ORTB]: { activated: enabled } } };
      const out = spec.buildRequests(bids, JSON.parse(JSON.stringify(BIDDER_REQUEST)));
      const req = Array.isArray(out) ? out[0] : out;
      return JSON.parse(JSON.stringify(req.data));
    }

    let savedRequested;
    beforeEach(function () {
      ixSandbox.stub(storage, 'localStorageIsEnabled').returns(false);
      savedRequested = FEATURE_TOGGLES.REQUESTED_FEATURE_TOGGLES;
      FEATURE_TOGGLES.REQUESTED_FEATURE_TOGGLES = [ORTB];
    });
    afterEach(function () {
      FEATURE_TOGGLES.REQUESTED_FEATURE_TOGGLES = savedRequested;
    });

    Object.keys(SCENARIOS).forEach((name) => {
      it(`${name}: same request as Legacy apart from accepted differences`, function () {
        const legacy = build(false, SCENARIOS[name]());
        const ortb = build(true, SCENARIOS[name]());

        expect(ortb.imp.map((imp) => imp.id), 'imp order').to.deep.equal(legacy.imp.map((imp) => imp.id));
        const byId = (data) => ({ ...data, imp: Object.fromEntries(data.imp.map((imp) => [imp.id, imp])) });
        const unexpected = diff(byId(legacy), byId(ortb))
          .filter(({ path }) => !ACCEPTED.some(([pattern]) => pattern.test(path)))
          .map(({ path, legacy: l, ortb: o }) => `${path}: Legacy=${JSON.stringify(l)} ORTB=${JSON.stringify(o)}`);
        expect(unexpected, unexpected.join('\n')).to.deep.equal([]);
      });
    });
  });
  describe('response parity with Legacy', function () {
    const ORTB = 'pbjs_enable_ortbconverter';
    const VIDEO = { context: 'outstream', playerSize: [[640, 360]], mimes: ['video/mp4'], protocols: [2, 3], minduration: 5, maxduration: 30, plcmt: 4 };
    const NATIVE_REQ = { ver: '1.2', assets: [{ id: 1, required: 1, title: { len: 25 } }] };
    const BIDDER_REQUEST = { bidderCode: 'ix', bidderRequestId: 'breq', auctionId: 'auc', timeout: 1000, refererInfo: { page: 'https://pub.example/' }, ortb2: {} };

    function bid(id, code, mediaTypes, params = {}) {
      const b = {
        bidder: 'ix',
        bidId: id,
        bidderRequestId: 'breq',
        auctionId: 'auc',
        adUnitCode: code,
        params: { siteId: '1000', ...params },
        mediaTypes: JSON.parse(JSON.stringify(mediaTypes)),
        ortb2Imp: { ext: { gpid: `/1/${code}` } }
      };
      if (mediaTypes.native) b.nativeOrtbRequest = JSON.parse(JSON.stringify(NATIVE_REQ));
      return b;
    }
    function bids() {
      const list = [
        bid('b1', 'ban', { banner: { sizes: [[300, 250], [728, 90]] } }, { size: [300, 250] }),
        bid('b2', 'ban', { banner: { sizes: [[300, 250], [728, 90]] } }, { size: [728, 90], siteId: '1001' })
      ];
      if (FEATURES.VIDEO) {
        list.push(bid('v1', 'vid', { video: VIDEO }));
        list.push(bid('i1', 'vin', { video: { ...VIDEO, context: 'instream' } }));
      }
      if (FEATURES.NATIVE) list.push(bid('n1', 'nat', { native: {} }));
      return list;
    }
    function serverBody(imps) {
      const ids = imps.map((imp) => imp.id);
      const ext = { dspid: 101, advbrandid: 303, advbrand: 'Brand' };
      const nativeAdm = (text) => JSON.stringify({ native: { assets: [{ id: 1, title: { text } }], link: { url: 'https://c.example' } } });
      return {
        id: 'resp',
        cur: 'USD',
        seatbid: [{
          seat: '3970',
          bid: [
            { id: 'r1', impid: 'b1', price: 150, w: 728, h: 90, adm: '<div>ad</div>', crid: 'c1', adomain: ['adv.com'], dealid: 'deal1', mtype: 1, ext },
            { id: 'r1b', impid: 'b1', price: 120, w: 300, h: 250, adm: '<div>no mtype</div>', crid: 'c1b', ext },
            // exchange VAST URL: Legacy uses vastUrl only, never the inline adm
            { id: 'r2', impid: 'v1', price: 500, w: 640, h: 360, adm: '<VAST version="3.0"></VAST>', crid: 'c2', mtype: 2, ext: { ...ext, vasturl: 'https://vast.example/v.xml' } },
            { id: 'r3', impid: 'i1', price: 400, w: 640, h: 360, adm: '<VAST version="4.0"></VAST>', crid: 'c3', mtype: 2, ext },
            { id: 'r4', impid: 'n1', price: 100, adm: nativeAdm('Hi'), crid: 'c4', mtype: 4, ext },
            // no mtype: Legacy infers native from the {"native": ...} wrapper
            { id: 'r5', impid: 'n1', price: 90, adm: nativeAdm('No mtype'), crid: 'c5', ext }
          ].filter((b) => ids.includes(b.impid))
        }],
        ext: { videoplayerurl: 'https://js-sec.indexww.com/htv/video-player.js' }
      };
    }
    // Fields the converter adds that Legacy does not set; they don't change how the bid is used.
    const ORTB_ONLY = ['creative_id', 'seatBidId', 'playerWidth', 'playerHeight', 'renderer'];

    function run(enabled) {
      FEATURE_TOGGLES.featureToggles = { features: { [ORTB]: { activated: enabled } } };
      const out = spec.buildRequests(bids(), JSON.parse(JSON.stringify(BIDDER_REQUEST)));
      const req = Array.isArray(out) ? out[0] : out;
      const result = spec.interpretResponse({ body: serverBody(req.data.imp) }, req);
      return {
        url: req.url,
        options: req.options,
        bids: (Array.isArray(result) ? result : result.bids).map((b) => {
          const copy = JSON.parse(JSON.stringify({ ...b, renderer: undefined }));
          ORTB_ONLY.forEach((key) => delete copy[key]);
          // converter adds IAB category ids to meta; compare the Legacy meta fields
          if (copy.meta) {
            delete copy.meta.primaryCatId;
            delete copy.meta.secondaryCatIds;
          }
          return { ...copy, hasRenderer: !!b.renderer };
        }).sort((a, b) => a.requestId.localeCompare(b.requestId) || b.cpm - a.cpm)
      };
    }

    beforeEach(function () {
      ixSandbox.stub(storage, 'localStorageIsEnabled').returns(false);
    });

    it('same endpoint, options and parsed bids as Legacy (incl. vastUrl precedence, native wrapper, missing mtype)', function () {
      const legacy = run(false);
      const ortb = run(true);

      expect(ortb.url).to.equal(legacy.url);
      expect(ortb.options).to.deep.equal(legacy.options);
      expect(ortb.bids.length).to.equal(legacy.bids.length);
      ortb.bids.forEach((b, i) => expect(b, b.requestId).to.deep.equal(legacy.bids[i]));
    });
  });
  describe('config-driven parity with Legacy', function () {
    const ORTB = 'pbjs_enable_ortbconverter';
    const banner = (id, params = {}) => ({
      bidder: 'ix',
      bidId: id,
      bidderRequestId: 'breq',
      auctionId: 'auc',
      adUnitCode: 'unit',
      params: { siteId: '1000', size: [300, 250], ...params },
      mediaTypes: { banner: { sizes: [[300, 250], [728, 90]] } },
      ortb2Imp: { ext: { gpid: '/1/unit' } }
    });
    const CASES = {
      'exchangeId + externalId': { cfg: { exchangeId: 123 }, bids: () => [banner('a', { externalId: 'ext-1' })] },
      'coppa: true': { cfg: { coppa: true }, ortb2: { regs: { coppa: 1 } } },
      // Prebid writes regs.coppa = 0 for coppa: false and it is sent as the publisher set it; Legacy omits it
      'coppa: false': {
        cfg: { coppa: false },
        ortb2: { regs: { coppa: 0 } },
        accepted: /^\.regs(\.coppa)?$/,
        check: (ortb) => expect(ortb.regs.coppa).to.equal(0)
      },
      'ix detectMissingSizes: false': { cfg: { ix: { detectMissingSizes: false } } },
      'gpp module': { gppConsent: { gppString: 'GPP', applicableSections: [7, 8] }, ortb2: { regs: { gpp: 'GPP', gpp_sid: [7, 8] } } }
    };
    const IGNORED = /^(\.ext\.ixdiag\.(version|userIds|vpd)|\.ext\.features\..*|\.device\..*|\.imp\[\d+\]\.secure|\.test|\.tmax|.*\.bidfloorcur|\.source|\.user)$/;

    function diff(a, b, path = '', out = []) {
      if (JSON.stringify(a) === JSON.stringify(b)) return out;
      if (a && b && typeof a === 'object' && typeof b === 'object' && Array.isArray(a) === Array.isArray(b)) {
        const keys = Array.isArray(a) ? [...Array(Math.max(a.length, b.length)).keys()] : [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();
        keys.forEach((k) => diff(a[k], b[k], path + (Array.isArray(a) ? `[${k}]` : `.${k}`), out));
        return out;
      }
      out.push(`${path}: Legacy=${JSON.stringify(a)} ORTB=${JSON.stringify(b)}`);
      return out;
    }

    beforeEach(function () {
      ixSandbox.stub(storage, 'localStorageIsEnabled').returns(false);
    });
    afterEach(function () {
      config.resetConfig();
    });

    it('documents a known difference: ix.firstPartyData is appended to site.page by Legacy only', function () {
      config.setConfig({ ix: { firstPartyData: { abc: '123' } } });
      const page = (enabled) => {
        FEATURE_TOGGLES.featureToggles = { features: { [ORTB]: { activated: enabled } } };
        const out = spec.buildRequests([banner('a')], {
          bidderCode: 'ix',
          bidderRequestId: 'breq',
          auctionId: 'auc',
          timeout: 1000,
          refererInfo: { page: 'https://pub.example/p' },
          ortb2: { site: { page: 'https://pub.example/p' } }
        });
        return (Array.isArray(out) ? out[0] : out).data.site.page;
      };
      expect(page(false)).to.equal('https://pub.example/p?abc=123');
      // Not ported to the ORTB path (out of scope for this change); see UPDATE_NOTES.md
      expect(page(true)).to.equal('https://pub.example/p');
    });

    Object.keys(CASES).forEach((name) => {
      it(`${name}: same endpoint and request as Legacy`, function () {
        const c = CASES[name];
        const run = (enabled) => {
          config.resetConfig();
          config.setConfig(c.cfg || {});
          FEATURE_TOGGLES.featureToggles = { features: { [ORTB]: { activated: enabled } } };
          const bidderRequest = {
            bidderCode: 'ix',
            bidderRequestId: 'breq',
            auctionId: 'auc',
            timeout: 1000,
            refererInfo: { page: 'https://pub.example/p' },
            ortb2: { site: { page: 'https://pub.example/p' }, ...(c.ortb2 || {}) }
          };
          if (c.gppConsent) bidderRequest.gppConsent = c.gppConsent;
          const out = spec.buildRequests((c.bids || (() => [banner('a')]))(), bidderRequest);
          const req = Array.isArray(out) ? out[0] : out;
          return { url: req.url, data: JSON.parse(JSON.stringify(req.data)) };
        };
        const legacy = run(false);
        const ortb = run(true);

        expect(ortb.url).to.equal(legacy.url);
        const unexpected = diff(legacy.data, ortb.data)
          .filter((d) => !IGNORED.test(d.split(':')[0]) && !(c.accepted && c.accepted.test(d.split(':')[0])));
        expect(unexpected, unexpected.join('\n')).to.deep.equal([]);
        if (c.check) c.check(ortb.data);
      });
    });
  });
  describe('browser parity suite findings', function () {
    const ORTB = 'pbjs_enable_ortbconverter';
    const VIDEO = { context: 'instream', playerSize: [[640, 480]], mimes: ['video/mp4'], protocols: [2, 3, 5, 6], minduration: 5, maxduration: 30 };
    const NATIVE_REQ = { ver: '1.2', assets: [{ id: 1, required: 1, title: { len: 25 } }] };

    function ixBid(id, code, mediaTypes, params = {}, extra = {}) {
      const b = {
        bidder: 'ix',
        bidId: id,
        bidderRequestId: 'breq',
        auctionId: 'auc',
        adUnitCode: code,
        params: { siteId: '1000', ...params },
        mediaTypes: JSON.parse(JSON.stringify(mediaTypes)),
        ortb2Imp: { ext: { gpid: `/1/${code}` } },
        ...extra
      };
      // Prebid core mirrors mediaTypes.video into ortb2Imp.video
      if (mediaTypes.video) b.ortb2Imp.video = JSON.parse(JSON.stringify(mediaTypes.video));
      if (mediaTypes.native) b.nativeOrtbRequest = JSON.parse(JSON.stringify(NATIVE_REQ));
      return b;
    }
    function build(enabled, bids, bidderRequest = {}) {
      FEATURE_TOGGLES.featureToggles = { features: { [ORTB]: { activated: enabled } } };
      const out = spec.buildRequests(bids, { refererInfo: { page: 'https://example.com' }, timeout: 1000, ...bidderRequest });
      const req = Array.isArray(out) ? out[0] : out;
      return JSON.parse(JSON.stringify(req.data));
    }

    let savedRequested;
    beforeEach(function () {
      ixSandbox.stub(storage, 'localStorageIsEnabled').returns(false);
      savedRequested = FEATURE_TOGGLES.REQUESTED_FEATURE_TOGGLES;
      FEATURE_TOGGLES.REQUESTED_FEATURE_TOGGLES = [ORTB];
    });
    afterEach(function () {
      FEATURE_TOGGLES.REQUESTED_FEATURE_TOGGLES = savedRequested;
    });

    it('does not send banner.ext (params.banner.siteId stays on the format), like Legacy', function () {
      const make = () => [
        ixBid('A', 'u', { banner: { sizes: [[300, 250], [728, 90]] } }, { size: [300, 250], banner: { siteId: '2001' } }),
        ixBid('B', 'u', { banner: { sizes: [[300, 250], [728, 90]] } }, { size: [728, 90] })
      ];
      const legacy = build(false, make());
      const ortb = build(true, make());
      expect(ortb.imp[0].banner.ext).to.equal(undefined);
      expect(ortb.imp[0].banner.format.map((f) => f.ext.siteID)).to.deep.equal(legacy.imp[0].banner.format.map((f) => f.ext.siteID));
    });

    it('passes converter fields through (ext.prebid, tidSource, igs)', function () {
      const make = () => [ixBid('A', 'u', { banner: { sizes: [[300, 250]] } }, { size: [300, 250] }, {
        ortb2Imp: { ext: { gpid: '/1/u', tid: 't1', tidSource: 'pbjs', igs: { ae: 1, biddable: 1 } } }
      })];
      const ortb = build(true, make(), { ortb2: { ext: { prebid: { adServerCurrency: 'USD' } }, source: { ext: { tidSource: 'pbjs' } } } });
      expect(ortb.ext.prebid).to.deep.equal({ adServerCurrency: 'USD' });
      expect(ortb.source.ext.tidSource).to.equal('pbjs');
      expect(ortb.imp[0].ext).to.include.keys('tidSource', 'igs');
    });

    if (FEATURES.VIDEO) {
      it('params.video wins over mediaTypes.video (incl. arrays), like Legacy', function () {
        const make = () => [ixBid('V', 'v', { video: VIDEO }, { video: { skip: 1, maxduration: 15, protocols: [2] } })];
        const legacy = build(false, make());
        const ortb = build(true, make());
        expect(ortb.imp[0].video.protocols).to.deep.equal([2]);
        expect(ortb.imp[0].video.maxduration).to.equal(15);
        expect(ortb.imp[0].video.skip).to.equal(1);
        ['protocols', 'maxduration', 'minduration', 'skip', 'mimes'].forEach((k) => expect(ortb.imp[0].video[k], k).to.deep.equal(legacy.imp[0].video[k]));
      });

      it('does not mutate the publisher\'s params.video or mediaTypes.video', function () {
        const bid = ixBid('V', 'v', { video: VIDEO }, { video: { protocols: [2] } });
        build(true, [bid]);
        expect(bid.params.video.protocols).to.deep.equal([2]);
        expect(bid.mediaTypes.video.protocols).to.deep.equal([2, 3, 5, 6]);
      });
    }

    if (FEATURES.VIDEO && FEATURES.NATIVE) {
      it('keeps each media floor on multi-format imps, with the same values as Legacy', function () {
        const floors = (o) => ({ floor: o.mediaType === 'video' ? 5 : o.mediaType === 'native' ? 2 : 1, currency: 'USD' });
        const make = () => {
          const media = { banner: { sizes: [[300, 250], [728, 90]] }, video: VIDEO, native: {} };
          return [
            ixBid('A', 'mf', media, { size: [300, 250] }, { getFloor: floors }),
            ixBid('B', 'mf', media, { size: [728, 90] }, { getFloor: floors })
          ];
        };
        const legacy = build(false, make());
        const ortb = build(true, make());
        const other = (d) => d.imp.find((imp) => imp.video && imp.native);
        expect(other(ortb).video.ext.bidfloor).to.equal(other(legacy).video.ext.bidfloor);
        expect(other(ortb).native.ext.bidfloor).to.equal(other(legacy).native.ext.bidfloor);
        expect(other(ortb).video.ext.fl).to.equal('p');
      });
    }
  });
});
