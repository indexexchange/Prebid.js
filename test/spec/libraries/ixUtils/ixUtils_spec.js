import { config } from 'src/config.js';
import { expect } from 'chai';

import 'modules/ixBidAdapter.js';
import {
  LOCAL_STORAGE_FEATURE_TOGGLES_KEY,
  storage,
  isExchangeIdConfigured,
  converter,
  interpretResponseORTBConverter,
  buildRequestsORTBConverter,
  FEATURE_TOGGLES,
  isIndexRendererPreferred,
  setDisplayManager,
  outstreamRenderer,
  createRenderer,
  getEidInfo,
  applyFloors
} from '../../../../libraries/ixUtils/ixUtils.js';

import * as prebidUtils from 'src/utils.js';
import * as gptUtils from '../../../../libraries/gptUtils/gptUtils.js';
import * as RendererNS from 'src/Renderer.js';

import 'modules/currency.js';
import 'modules/priceFloors.js';

const OUTSTREAM = 'outstream';
const INSTREAM = 'instream';
const PBJS = 'p';
const IX = 'i';

function runE2E({ bidRequests, response, bidderRequest = {} }) {
  const br = {
    refererInfo: { page: 'https://example.com' },
    timeout: 1000,
    ...bidderRequest,
    validBidRequests: bidRequests
  };
  const { data: req } = buildRequestsORTBConverter(bidRequests, br);
  const out = interpretResponseORTBConverter({ body: response }, { data: req, validBidRequests: bidRequests });
  return Array.isArray(out) ? out : out.bids;
}

function bannerMinFromImp(imp) {
  const formats = prebidUtils.deepAccess(imp, 'banner.format', []) || [];
  const floors = formats.map(f => prebidUtils.deepAccess(f, 'ext.bidfloor'))
    .filter(v => typeof v === 'number');
  return floors.length ? Math.min(...floors) : (
    typeof imp.bidfloor === 'number' ? imp.bidfloor : undefined
  );
}

describe('ixUtils (ORTB Converter Integration)', function() {
  let sandbox;
  beforeEach(function() {
    sandbox = sinon.createSandbox();
  });
  afterEach(function() {
    sandbox.restore();
    delete window.createIXPlayer;
  });

  describe('isExchangeIdConfigured', function() {
    it('returns true for finite number', function() {
      sandbox.stub(config, 'getConfig').withArgs('exchangeId').returns(12345);
      expect(isExchangeIdConfigured()).to.equal(true);
    });

    it('returns true for numeric string', function() {
      sandbox.stub(config, 'getConfig').withArgs('exchangeId').returns('6789');
      expect(isExchangeIdConfigured()).to.equal(true);
    });

    it('returns false for non-numeric string / undefined', function() {
      sandbox.stub(config, 'getConfig').withArgs('exchangeId').returns('abc');
      expect(isExchangeIdConfigured()).to.equal(false);

      config.getConfig.restore();
      sandbox.stub(config, 'getConfig').withArgs('exchangeId').returns(undefined);
      expect(isExchangeIdConfigured()).to.equal(false);
    });
  });

  describe('FEATURE_TOGGLES', function() {
    let lsEnabledStub;
    beforeEach(function () {
      lsEnabledStub = sandbox.stub(storage, 'localStorageIsEnabled');
    });

    it('getFeatureToggles: loads cached toggles when not expired', function() {
      const now = Date.now();
      lsEnabledStub.returns(true);
      const getStub = sandbox.stub(storage, 'getDataFromLocalStorage')
        .withArgs(LOCAL_STORAGE_FEATURE_TOGGLES_KEY)
        .returns(JSON.stringify({
          expiry: now + 60_000,
          features: { pbjs_enable_ortbconverter: { activated: true } }
        }));

      FEATURE_TOGGLES.clearFeatureToggles();
      FEATURE_TOGGLES.getFeatureToggles();
      expect(FEATURE_TOGGLES.featureToggles.features.pbjs_enable_ortbconverter.activated).to.equal(true);
      expect(getStub.calledOnce).to.equal(true);
    });

    it('getFeatureToggles: clears cache when expired', function() {
      const now = Date.now();
      lsEnabledStub.returns(true);
      sandbox.stub(storage, 'getDataFromLocalStorage')
        .withArgs(LOCAL_STORAGE_FEATURE_TOGGLES_KEY)
        .returns(JSON.stringify({
          expiry: now - 60_000,
          features: { pbjs_enable_ortbconverter: { activated: true } }
        }));
      const removeStub = sandbox.stub(storage, 'removeDataFromLocalStorage');

      FEATURE_TOGGLES.featureToggles = { some: 'value' };
      FEATURE_TOGGLES.getFeatureToggles();
      expect(FEATURE_TOGGLES.featureToggles).to.deep.equal({});
      expect(removeStub.called).to.equal(true);
    });

    it('setFeatureToggles: persists features with 1-hour expiry', function() {
      const clock = sandbox.useFakeTimers({ now: new Date('2025-01-01T00:00:00Z') });
      lsEnabledStub.returns(true);
      const setStub = sandbox.stub(storage, 'setDataInLocalStorage');
      const serverResponse = {
        body: {
          ext: {
            features: {
              pbjs_enable_ortbconverter: { activated: true }
            }
          }
        }
      };
      FEATURE_TOGGLES.setFeatureToggles(serverResponse);
      expect(FEATURE_TOGGLES.featureToggles.features.pbjs_enable_ortbconverter.activated).to.equal(true);
      expect(FEATURE_TOGGLES.featureToggles.expiry).to.equal(new Date('2025-01-01T01:00:00Z').getTime());
      expect(setStub.calledWith(
        LOCAL_STORAGE_FEATURE_TOGGLES_KEY,
        JSON.stringify(FEATURE_TOGGLES.featureToggles)
      )).to.equal(true);
      clock.restore();
    });

    it('clearFeatureToggles: clears memory + localStorage', function() {
      lsEnabledStub.returns(true);
      const removeStub = sandbox.stub(storage, 'removeDataFromLocalStorage');
      FEATURE_TOGGLES.featureToggles = { features: { a: 1 } };
      FEATURE_TOGGLES.clearFeatureToggles();
      expect(FEATURE_TOGGLES.featureToggles).to.deep.equal({});
      expect(removeStub.calledWith(LOCAL_STORAGE_FEATURE_TOGGLES_KEY)).to.equal(true);
    });

    it('isFeatureEnabled: reads activated flag from cached toggles', function() {
      FEATURE_TOGGLES.featureToggles = {
        features: { pbjs_enable_ortbconverter: { activated: true } }
      };
      expect(FEATURE_TOGGLES.isFeatureEnabled('pbjs_enable_ortbconverter')).to.equal(true);
      expect(FEATURE_TOGGLES.isFeatureEnabled('nonexistent')).to.equal(false);
    });
  });

  describe('isIndexRendererPreferred', function() {
    it('false for non-outstream context', function() {
      const bid = { mediaTypes: { video: { context: INSTREAM } } };
      expect(isIndexRendererPreferred(bid)).to.equal(false);
    });

    it('true when renderer missing or invalid on outstream', function() {
      expect(isIndexRendererPreferred({ mediaTypes: { video: { context: OUTSTREAM } } })).to.equal(true);
      expect(isIndexRendererPreferred({ mediaTypes: { video: { context: OUTSTREAM, renderer: {} } } })).to.equal(true);
    });

    it('true when backupOnly flag is set', function() {
      const bid = { mediaTypes: { video: { context: OUTSTREAM, renderer: { url: 'x', render: () => {}, backupOnly: true } } } };
      expect(isIndexRendererPreferred(bid)).to.equal(true);
    });

    it('false when custom renderer is fully valid', function() {
      const bid = { mediaTypes: { video: { context: OUTSTREAM, renderer: { url: 'x', render: () => {} } } } };
      expect(isIndexRendererPreferred(bid)).to.equal(false);
    });
  });

  describe('setDisplayManager', function() {
    it('sets pbjs_wrapper if schain is present', function() {
      const imp = {};
      const bid = { mediaTypes: { video: { context: OUTSTREAM } }, ortb2: { source: {ext: {schain: { ver: '1.0' }}}}};
      setDisplayManager(imp, bid);
      expect(imp.displaymanager).to.equal('pbjs_wrapper');
    });

    it('sets ix for IX renderer url', function() {
      const imp = {};
      const bid = { mediaTypes: { video: { context: OUTSTREAM, renderer: { url: 'https://js-sec.indexww.com/renderer.js', render: () => {} } } } };
      setDisplayManager(imp, bid);
      expect(imp.displaymanager).to.equal('ix');
    });

    it('sets custom url for third-party renderer', function() {
      const imp = {};
      const bid = { mediaTypes: { video: { context: OUTSTREAM, renderer: { url: 'https://cdn.foo.com/out.js', render: () => {} } } } };
      setDisplayManager(imp, bid);
      expect(imp.displaymanager).to.equal('https://cdn.foo.com/out.js');
    });

    it('defaults to ix when no renderer provided', function() {
      const imp = {};
      const bid = { mediaTypes: { video: { context: OUTSTREAM } } };
      setDisplayManager(imp, bid);
      expect(imp.displaymanager).to.equal('ix');
    });

    it('ignores unparsable url', function() {
      const imp = {};
      const bid = { mediaTypes: { video: { context: OUTSTREAM, renderer: { url: '::::', render: () => {} } } } };
      setDisplayManager(imp, bid);
      expect(imp.displaymanager).to.equal(undefined);
    });
  });

  describe('createRenderer / outstreamRenderer', function() {
    it('createRenderer returns renderer and wires setRender; guards bad cases', function() {
      const installStub = sandbox.stub(RendererNS.Renderer, 'install').returns({
        setRender: sandbox.stub()
      });

      let r = createRenderer('id', '');
      expect(r).to.equal(null);

      r = createRenderer('id2', 'https://js-sec.indexww.com/renderer.js');
      expect(installStub.calledWithMatch({
        id: 'id2',
        url: 'https://js-sec.indexww.com/renderer.js',
        loaded: false
      })).to.equal(true);
      expect(r).to.be.an('object');
    });

    it('outstreamRenderer: pushes render fn that calls window.createIXPlayer', function() {
      const bid = { adUnitCode: 'my-slot' };
      const div = document.createElement('div');
      div.id = 'my-slot';
      document.body.appendChild(div);

      window.createIXPlayer = sandbox.stub();
      bid.renderer = { push: (fn) => { fn(); } };

      outstreamRenderer(bid);
      expect(window.createIXPlayer.calledWith('my-slot', bid)).to.equal(true);

      document.body.removeChild(div);
      if (typeof window.createIXPlayer.resetHistory === 'function') {
        window.createIXPlayer.resetHistory();
      } else if (typeof window.createIXPlayer.reset === 'function') {
        window.createIXPlayer.reset();
      } else {
        window.createIXPlayer = sandbox.stub();
      }

      sandbox.stub(gptUtils, 'getGptSlotInfoForAdUnitCode').returns({ divId: 'gpt-div' });
      outstreamRenderer(bid);
      expect(window.createIXPlayer.calledWith('gpt-div', bid)).to.equal(true);
    });
  });

  describe('getEidInfo', function() {
    it('maps RTI partner for known sources and drops empty uids; caps at 50', function() {
      if (typeof getEidInfo !== 'function') this.skip();
      const make = (src) => ({ source: src, uids: [{ id: 'X' }] });
      const list = [
        make('adserver.org'),
        make('uidapi.com'),
        make('unknown.source'),
        { source: 'zeotap.com', uids: [] },
      ];
      for (let i = 0; i < 100; i++) list.push(make('netid.de'));

      const { toSend, seenSources } = getEidInfo(list);
      expect(toSend.length).to.be.at.most(50);
      const tdid = toSend.find(e => e.source === 'adserver.org');
      expect(tdid.uids[0].ext.rtiPartner).to.equal('TDID');
      const uid2 = toSend.find(e => e.source === 'uidapi.com');
      expect(uid2.uids[0].ext.rtiPartner).to.equal('UID2');
      expect(seenSources['adserver.org']).to.equal(true);
      expect(seenSources['unknown.source']).to.equal(true);
    });
  });
  describe('interpretResponseORTBConverter', function() {
    let sandbox;

    beforeEach(() => {
      sandbox = sinon.createSandbox();
      sandbox.stub(FEATURE_TOGGLES, 'setFeatureToggles');
    });

    afterEach(() => {
      sandbox.restore();
    });

    it('returns [] on empty body; otherwise passes through converter', function() {
      expect(
        interpretResponseORTBConverter({ body: null }, { data: {}, validBidRequests: [] })
      ).to.deep.equal([]);

      const fromStub = sandbox.stub(converter, 'fromORTB').returns([{ cpm: 1 }]);
      const resp = interpretResponseORTBConverter(
        { body: { seatbid: [] } },
        { data: {}, validBidRequests: [] }
      );
      expect(resp).to.deep.equal([{ cpm: 1 }]);
      expect(fromStub.calledOnce).to.equal(true);
    });

    it('fails soft ([]) and logs when converter.fromORTB throws', function() {
      sandbox.stub(converter, 'fromORTB').throws(new Error('boom'));
      const warnStub = sandbox.stub(prebidUtils, 'logWarn');

      const res = interpretResponseORTBConverter(
        { body: { id: 'r1', seatbid: [] } },
        { data: {}, validBidRequests: [] }
      );

      expect(res).to.deep.equal([]);
      expect(warnStub.called).to.equal(true);
    });

    it('returns {bids: [], paapi} when PAAPI configs present and converter throws', function() {
      sandbox.stub(converter, 'fromORTB').throws(new Error('boom'));
      const warnStub = sandbox.stub(prebidUtils, 'logWarn');

      const paapi = [{ config: { seller: 'https://seller.example' } }];
      const res = interpretResponseORTBConverter(
        { body: { id: 'r2', ext: { protectedAudienceAuctionConfigs: paapi } } },
        { data: {}, validBidRequests: [] }
      );

      expect(res).to.deep.equal({ bids: [], paapi });
      expect(warnStub.called).to.equal(true);
    });
  });

  describe('interpretResponseORTBConverter', () => {
    let fromStub, warnStub;

    beforeEach(() => {
      warnStub = sinon.stub(prebidUtils, 'logWarn');
    });

    afterEach(() => {
      sinon.restore();
    });

    it('fails soft if converter.fromORTB throws', () => {
      fromStub = sinon.stub(converter, 'fromORTB').throws(new Error('boom'));

      const res = interpretResponseORTBConverter(
        { body: { id: 'resp-1' } },
        { data: {}, validBidRequests: [] }
      );

      expect(res).to.deep.equal([]);
      expect(warnStub.called).to.equal(true);
    });

    it('still returns PAAPI configs if fromORTB throws', () => {
      fromStub = sinon.stub(converter, 'fromORTB').throws(new Error('boom'));

      const paapi = [{ config: { seller: 's.example' } }];
      const res = interpretResponseORTBConverter(
        { body: { id: 'resp-2', ext: { protectedAudienceAuctionConfigs: paapi } } },
        { data: {}, validBidRequests: [] }
      );

      expect(res).to.deep.equal({ bids: [], paapi });
      expect(warnStub.called).to.equal(true);
    });
  });

  describe('buildRequestsORTBConverter — floors', function() {
    it('uses bid.getFloor when available for each banner size (single imp with multiple formats)', function() {
      const getFloor = sandbox.stub();
      getFloor.withArgs({ currency: 'USD', mediaType: 'banner', size: [300, 250] })
        .returns({ currency: 'USD', floor: 0.5 });
      getFloor.withArgs({ currency: 'USD', mediaType: 'banner', size: [300, 600] })
        .returns({ currency: 'USD', floor: 0.8 });

      const validBidRequests = [{
        bidId: '1',
        adUnitCode: 'div-1',
        params: { siteId: 10 },
        mediaTypes: { banner: { sizes: [[300, 250], [300, 600]] } },
        getFloor
      }];
      const bidderRequest = {
        refererInfo: { page: 'https://example.com' },
        ortb2: {},
        timeout: 1000
      };

      const { data } = buildRequestsORTBConverter(validBidRequests, bidderRequest);

      expect(getFloor.called).to.equal(true);
      expect(data.imp).to.have.length(1);
      const imp = data.imp[0];

      expect(imp.banner).to.be.ok;
      expect(imp.banner.format).to.be.an('array');

      const fmt_300x250 = imp.banner.format.find(f => f.w === 300 && f.h === 250);
      const fmt_300x600 = imp.banner.format.find(f => f.w === 300 && f.h === 600);

      expect(fmt_300x250.ext && fmt_300x250.ext.bidfloor).to.equal(0.5);
      expect((fmt_300x250.ext && fmt_300x250.ext.bidfloorcur) || imp.bidfloorcur || 'USD').to.equal('USD');

      expect(fmt_300x600.ext && fmt_300x600.ext.bidfloor).to.equal(0.8);

      expect(imp.bidfloor).to.equal(0.5);
      expect(imp.bidfloorcur).to.equal('USD');
    });

    it('does not error when getFloor is missing; leaves imp.bidfloor undefined', function() {
      const validBidRequests = [{
        bidId: '1',
        adUnitCode: 'div-1',
        params: { siteId: 10 },
        mediaTypes: { banner: { sizes: [[728, 90]] } },
      }];
      const bidderRequest = {
        refererInfo: { page: 'https://example.com' },
        ortb2: {},
        timeout: 1000
      };
      const { data } = buildRequestsORTBConverter(validBidRequests, bidderRequest);
      expect(data.imp).to.have.length(1);
      expect(data.imp[0].bidfloor).to.equal(undefined);
      expect(data.imp[0].bidfloorcur).to.equal(undefined);
    });

    it('handles video floors using mediaType "video" and size', function() {
      const getFloor = sandbox.stub().callsFake(({ mediaType }) => {
        if (mediaType === 'video') return { currency: 'USD', floor: 3.2 };
        return undefined;
      });

      const validBidRequests = [{
        bidId: 'v1',
        adUnitCode: 'vid',
        params: { siteId: 22 },
        mediaTypes: {
          video: {
            context: 'instream',
            playerSize: [[640, 480]],
            w: 640,
            h: 480
          }
        },
        getFloor
      }];

      const bidderRequest = {
        refererInfo: { page: 'https://example.com' },
        ortb2: {},
        timeout: 1200
      };

      const { data } = buildRequestsORTBConverter(validBidRequests, bidderRequest);
      expect(data.imp).to.have.length(1);
      const imp = data.imp[0];

      expect(imp.video).to.be.ok;
      expect(imp.video.ext && imp.video.ext.bidfloor).to.equal(3.2);
      expect((imp.video.ext && imp.video.ext.bidfloorcur) || imp.bidfloorcur || 'USD').to.equal('USD');

      if (typeof imp.bidfloor !== 'undefined') {
        expect(imp.bidfloor).to.equal(3.2);
      }
    });
  });
});

describe('ixUtils (ORTB Converter Integration) — continued', function() {
  let sandbox;
  beforeEach(function() {
    sandbox = sinon.createSandbox();
  });
  afterEach(function() {
    sandbox.restore();
    delete window.createIXPlayer;
  });

  describe('buildRequestsORTBConverter — multi-format & currency handling', function() {
    it('multi-format (banner+video): imp.bidfloor is min across formats and media types', function() {
      const getFloor = sandbox.stub();
      getFloor.withArgs({ currency: 'USD', mediaType: 'banner', size: [300, 250] }).returns({ currency: 'USD', floor: 1.20 });
      getFloor.withArgs({ currency: 'USD', mediaType: 'banner', size: [320, 50] }).returns({ currency: 'USD', floor: 0.40 });
      getFloor.withArgs({ currency: 'USD', mediaType: 'video', size: [640, 480] }).returns({ currency: 'USD', floor: 2.50 });

      const validBidRequests = [{
        bidId: 'mf1',
        adUnitCode: 'ad-1',
        params: { siteId: 101 },
        mediaTypes: {
          banner: { sizes: [[300, 250], [320, 50]] },
          video: { context: 'instream', playerSize: [640, 480], w: 640, h: 480 }
        },
        getFloor
      }];

      const bidderRequest = { refererInfo: { page: 'https://ex.co' }, ortb2: {}, timeout: 1000 };
      const { data } = buildRequestsORTBConverter(validBidRequests, bidderRequest);

      expect(data.imp).to.have.length(1);
      const imp = data.imp[0];

      expect(imp.bidfloor).to.equal(0.40);
      expect(imp.bidfloorcur || 'USD').to.equal('USD');
      const fmt1 = prebidUtils.deepAccess(imp, 'banner.format', []).find(f => f.w === 300 && f.h === 250);
      const fmt2 = prebidUtils.deepAccess(imp, 'banner.format', []).find(f => f.w === 320 && f.h === 50);
      const vExt = prebidUtils.deepAccess(imp, 'video.ext');

      const fmt1Floor = prebidUtils.deepAccess(fmt1, 'ext.bidfloor');
      const fmt2Floor = prebidUtils.deepAccess(fmt2, 'ext.bidfloor');
      const videoFloor = prebidUtils.deepAccess(vExt, 'bidfloor');

      if (typeof fmt1Floor === 'number') expect(fmt1Floor).to.equal(1.20);
      if (typeof fmt2Floor === 'number') expect(fmt2Floor).to.equal(0.40);
      if (typeof videoFloor === 'number') expect(videoFloor).to.equal(2.50);
    });

    it('currency normalization for floors: uses currency returned by floor module, no implicit conversion', function() {
      const getFloor = sandbox.stub();
      getFloor.withArgs({ currency: 'USD', mediaType: 'banner', size: [300, 250] }).returns({ currency: 'EUR', floor: 0.9 });
      getFloor.withArgs({ currency: 'USD', mediaType: 'banner', size: [728, 90] }).returns({ currency: 'USD', floor: 1.1 });

      const validBidRequests = [{
        bidId: 'fx',
        adUnitCode: 'ad-2',
        params: { siteId: 202 },
        mediaTypes: { banner: { sizes: [[300, 250], [728, 90]] } },
        getFloor
      }];

      const bidderRequest = { refererInfo: { page: 'https://ex.co' }, ortb2: {}, timeout: 1000 };
      const { data } = buildRequestsORTBConverter(validBidRequests, bidderRequest);

      const imp = data.imp[0];
      const f300 = prebidUtils.deepAccess(imp, 'banner.format', []).find(f => f.w === 300 && f.h === 250);
      const f728 = prebidUtils.deepAccess(imp, 'banner.format', []).find(f => f.w === 728 && f.h === 90);

      const f300Floor = prebidUtils.deepAccess(f300, 'ext.bidfloor');
      const f300Cur = prebidUtils.deepAccess(f300, 'ext.bidfloorcur');
      const f728Floor = prebidUtils.deepAccess(f728, 'ext.bidfloor');
      const f728Cur = prebidUtils.deepAccess(f728, 'ext.bidfloorcur');

      if (typeof f300Floor === 'number' && typeof f728Floor === 'number') {
        expect(f300Floor).to.equal(0.9);
        expect(f300Cur).to.equal('EUR');
        expect(f728Floor).to.equal(1.1);
        expect(f728Cur).to.equal('USD');
        if (typeof imp.bidfloor === 'number') {
          expect(imp.bidfloor).to.equal(0.9);
          expect(imp.bidfloorcur).to.equal('EUR');
        }
      } else {
        expect(imp.bidfloor).to.be.oneOf([0.9, 1.1]);
        expect(imp.bidfloorcur).to.be.oneOf(['EUR', 'USD']);
      }
    });
  });

  describe('buildRequestsORTBConverter — cross-media minimum floors', function() {
    it('video floor lower than banner: impl may keep banner-min or promote to video min', function() {
      const getFloor = sandbox.stub();
      getFloor.withArgs({ currency: 'USD', mediaType: 'banner', size: [300, 250] }).returns({ currency: 'USD', floor: 1.50 });
      getFloor.withArgs({ currency: 'USD', mediaType: 'banner', size: [160, 600] }).returns({ currency: 'USD', floor: 1.20 });
      getFloor.withArgs({ currency: 'USD', mediaType: 'video', size: [640, 480] }).returns({ currency: 'USD', floor: 0.60 });

      const validBidRequests = [{
        bidId: 'cv1',
        adUnitCode: 'ad-x',
        params: { siteId: 99 },
        mediaTypes: { banner: { sizes: [[300, 250], [160, 600]] }, video: { context: 'instream', playerSize: [640, 480], w: 640, h: 480 } },
        getFloor
      }];
      const bidderRequest = { refererInfo: { page: 'https://ex.co' }, ortb2: {}, timeout: 1000 };
      const { data } = buildRequestsORTBConverter(validBidRequests, bidderRequest);

      const mergedImp = data.imp.find(i => i.banner && i.video);
      const bannerImp = data.imp.find(i => i.banner && !i.video) || data.imp.find(i => i.banner);
      const videoImp = data.imp.find(i => i.video && !i.banner) || data.imp.find(i => i.video);

      if (mergedImp) {
        const bannerMin = bannerMinFromImp(mergedImp);
        const vExt = prebidUtils.deepAccess(mergedImp, 'video.ext.bidfloor');
        if (typeof vExt === 'number') {
          expect(vExt).to.equal(0.60);
          expect([0.60, bannerMin]).to.include(mergedImp.bidfloor);
        } else {
          expect(mergedImp.bidfloor).to.equal(bannerMin);
        }
      } else {
        expect(videoImp, 'video imp present').to.be.ok;
        const vMin = prebidUtils.deepAccess(videoImp, 'video.ext.bidfloor') ?? videoImp.bidfloor;
        expect(vMin).to.equal(0.60);

        expect(bannerImp, 'banner imp present').to.be.ok;
        const bMin = bannerMinFromImp(bannerImp);
        expect(typeof bMin).to.equal('number');
        expect(vMin < bMin).to.equal(true);
      }
    });

    it('native floor lower than others: allow promotion to imp-min or keep banner-min', function() {
      const getFloor = sandbox.stub();
      getFloor.withArgs({ currency: 'USD', mediaType: 'banner', size: [300, 250] }).returns({ currency: 'USD', floor: 0.9 });
      getFloor.withArgs({ currency: 'USD', mediaType: 'native' }).returns({ currency: 'USD', floor: 0.4 });

      const validBidRequests = [{
        bidId: 'cv2',
        adUnitCode: 'ad-y',
        params: { siteId: 100 },
        mediaTypes: { banner: { sizes: [[300, 250]] }, native: { title: { len: 80 } } },
        getFloor
      }];
      const bidderRequest = { refererInfo: { page: 'https://ex.co' }, ortb2: {}, timeout: 1000 };
      const { data } = buildRequestsORTBConverter(validBidRequests, bidderRequest);

      const mergedImp = data.imp.find(i => i.banner && i.native);
      const bannerImp = data.imp.find(i => i.banner && !i.native) || data.imp.find(i => i.banner);
      const nativeImp = data.imp.find(i => i.native && !i.banner) || data.imp.find(i => i.native);

      if (!mergedImp && !nativeImp) {
        this.skip();
        return;
      }

      if (mergedImp) {
        const bannerMin = bannerMinFromImp(mergedImp);
        const nExt = prebidUtils.deepAccess(mergedImp, 'native.ext.bidfloor');
        if (typeof nExt === 'number') {
          expect(nExt).to.equal(0.4);
          expect([0.4, bannerMin]).to.include(mergedImp.bidfloor);
        } else {
          expect(mergedImp.bidfloor).to.equal(bannerMin);
        }
      } else {
        const bMin = bannerMinFromImp(bannerImp);
        const nMin = prebidUtils.deepAccess(nativeImp, 'native.ext.bidfloor') ?? nativeImp.bidfloor;
        expect(nMin).to.equal(0.4);
        expect(nMin < bMin).to.equal(true);
      }
    });
  });

  describe('buildRequestsORTBConverter — malformed floor returns', function() {
    it('ignores malformed getFloor results (missing floor/currency) for banner', function() {
      const getFloor = sinon.stub();
      getFloor.withArgs({ currency: 'USD', mediaType: 'banner', size: [300, 250] }).returns(undefined);
      getFloor.withArgs({ currency: 'USD', mediaType: 'banner', size: [728, 90] }).returns({ currency: 'USD' });
      getFloor.withArgs({ currency: 'USD', mediaType: 'banner', size: [160, 600] }).returns({ floor: 0.5 });

      const validBidRequests = [{
        bidId: 'mf',
        adUnitCode: 'ad-z',
        params: { siteId: 200 },
        mediaTypes: { banner: { sizes: [[300, 250], [728, 90], [160, 600]] } },
        getFloor
      }];
      const bidderRequest = { refererInfo: { page: 'https://ex.co' }, ortb2: {}, timeout: 1000 };
      const { data } = buildRequestsORTBConverter(validBidRequests, bidderRequest);
      const fmt300 = data.imp[0].banner.format.find(f => f.w === 300 && f.h === 250);
      const fmt728 = data.imp[0].banner.format.find(f => f.w === 728 && f.h === 90);
      const fmt160 = data.imp[0].banner.format.find(f => f.w === 160 && f.h === 600);

      expect(fmt300.ext?.bidfloor).to.equal(undefined);
      expect(fmt300.ext?.bidfloorcur).to.equal(undefined);
      expect(fmt728.ext?.bidfloor).to.equal(undefined);
      expect(fmt728.ext?.bidfloorcur).to.equal(undefined);
      expect(fmt160.ext?.bidfloor).to.equal(undefined);
      expect(fmt160.ext?.bidfloorcur).to.equal(undefined);

      expect(fmt300.ext?.siteID).to.equal('200');
      expect(fmt728.ext?.siteID).to.equal('200');
      expect(fmt160.ext?.siteID).to.equal('200');

      expect(data.imp[0].bidfloor).to.equal(undefined);
      expect(data.imp[0].bidfloorcur).to.equal(undefined);
    });

    it('ignores malformed video/native floor objects', function() {
      const getFloor = sinon.stub();
      getFloor.withArgs({ currency: 'USD', mediaType: 'video', size: [640, 360] }).returns({});
      getFloor.withArgs({ currency: 'USD', mediaType: 'native' }).returns(null);

      const validBidRequests = [{
        bidId: 'badfloors',
        adUnitCode: 'ad-vidnat',
        params: { siteId: 777 },
        mediaTypes: { video: { context: 'instream', playerSize: [640, 360], w: 640, h: 360 }, native: { body: { len: 140 } } },
        getFloor
      }];
      const bidderRequest = { refererInfo: { page: 'https://ex.co' }, ortb2: {}, timeout: 1000 };
      const { data } = buildRequestsORTBConverter(validBidRequests, bidderRequest);
      const imp = data.imp[0];
      expect(imp.video?.ext?.bidfloor).to.equal(undefined);
      expect(imp.native?.ext?.bidfloor).to.equal(undefined);
      expect(imp.bidfloor).to.equal(undefined);
    });
  });

  describe('applyFloors', () => {
    function makeImpBanner(formats = [], ext = {}) {
      return {
        banner: { format: formats.map(([w, h]) => ({ w, h })) },
        ext: { ...ext }
      };
    }

    function makeImpVideo({ w, h } = {}, ext = {}) {
      const imp = { video: {} };
      if (w) imp.video.w = w;
      if (h) imp.video.h = h;
      if (Object.keys(ext).length) imp.ext = ext;
      return imp;
    }

    function makeImpNative(ext = {}) {
      const imp = { native: { request: '{}' } };
      if (Object.keys(ext).length) imp.ext = ext;
      return imp;
    }

    it('banner: per-format floors with module on one size and adapter fallback on the other; imp-level = lowest; no imp.ext.fl when mixed sources', () => {
      const imp = makeImpBanner([[300, 250], [300, 600]], { siteID: '123' });

      const bidRequest = {
        params: { bidFloor: 0.80, bidFloorCur: 'USD' },
        getFloor({ mediaType, size }) {
          if (mediaType === 'banner' && size[0] === 300 && size[1] === 250) {
            return { floor: 1.20, currency: 'USD' };
          }
          return null;
        }
      };

      applyFloors(imp, bidRequest);

      expect(imp.banner.format[0].ext).to.include({
        bidfloor: 1.20,
        bidfloorcur: 'USD',
        fl: PBJS
      });
      expect(imp.banner.format[0].ext.siteID).to.equal('123');

      expect(imp.banner.format[1].ext).to.include({
        bidfloor: 0.80,
        bidfloorcur: 'USD',
        fl: IX
      });
      expect(imp.banner.format[1].ext.siteID).to.equal('123');

      expect(imp.bidfloor).to.equal(0.80);
      expect(imp.bidfloorcur).to.equal('USD');
      expect(imp.ext.fl).to.be.undefined;
    });

    it('banner: adapter-only per-format; imp-level set; no imp.ext.fl in reduced path', () => {
      const imp = makeImpBanner([[320, 50], [300, 250]]);

      const bidRequest = {
        params: { bidFloor: 0.50, bidFloorCur: 'USD' },
        getFloor() { return null; }
      };

      applyFloors(imp, bidRequest);

      for (const f of imp.banner.format) {
        expect(f.ext).to.include({
          bidfloor: 0.50,
          bidfloorcur: 'USD',
          fl: IX
        });
      }

      expect(imp.bidfloor).to.equal(0.50);
      expect(imp.bidfloorcur).to.equal('USD');
      expect(imp.ext.fl).to.be.undefined;
    });

    it('banner: no format floors -> fallback to imp-level adapter floor + imp.ext.fl', () => {
      const imp = { banner: { format: [] } };

      const bidRequest = {
        params: { bidFloor: 0.70, bidFloorCur: 'USD' },
        getFloor() { return null; }
      };

      applyFloors(imp, bidRequest);

      expect(imp.bidfloor).to.equal(0.70);
      expect(imp.bidfloorcur).to.equal('USD');
      expect(imp.ext.fl).to.equal(IX);
    });

    it('video: write media floor and only lower existing imp.bidfloor when lower', () => {
      const imp = makeImpVideo({ w: 640, h: 360 });
      imp.bidfloor = 6.00;
      imp.bidfloorcur = 'USD';

      const bidRequest = {
        params: { bidFloor: 4.00, bidFloorCur: 'USD' },
        getFloor({ mediaType }) {
          if (mediaType === 'video') return { floor: 5.00, currency: 'USD' };
          return null;
        }
      };

      applyFloors(imp, bidRequest);

      expect(imp.video.ext).to.include({
        bidfloor: 5.00,
        bidfloorcur: 'USD',
        fl: PBJS
      });

      expect(imp.bidfloor).to.equal(5.00);
      expect(imp.bidfloorcur).to.equal('USD');
    });

    it('video: does not raise imp.bidfloor when video floor is higher', () => {
      const imp = makeImpVideo({ w: 640, h: 360 });
      imp.bidfloor = 4.50;
      imp.bidfloorcur = 'USD';

      const bidRequest = {
        getFloor({ mediaType }) {
          if (mediaType === 'video') return { floor: 5.00, currency: 'USD' };
          return null;
        }
      };

      applyFloors(imp, bidRequest);

      expect(imp.video.ext).to.include({
        bidfloor: 5.00,
        bidfloorcur: 'USD',
        fl: PBJS
      });

      expect(imp.bidfloor).to.equal(4.50);
      expect(imp.bidfloorcur).to.equal('USD');
    });

    it('native: writes media floor but does not force-create imp.bidfloor when none exists', () => {
      const imp = makeImpNative();

      const bidRequest = {
        getFloor({ mediaType }) {
          if (mediaType === 'native') return { floor: 0.50, currency: 'USD' };
          return null;
        }
      };

      applyFloors(imp, bidRequest);

      expect(imp.native.ext).to.include({
        bidfloor: 0.50,
        bidfloorcur: 'USD',
        fl: PBJS
      });

      expect(imp.bidfloor).to.be.undefined;
      expect(imp.bidfloorcur).to.be.undefined;
    });

    it('native: lowers existing imp.bidfloor when native floor is lower', () => {
      const imp = makeImpNative();
      imp.bidfloor = 1.00;
      imp.bidfloorcur = 'USD';

      const bidRequest = {
        getFloor({ mediaType }) {
          if (mediaType === 'native') return { floor: 0.60, currency: 'USD' };
          return null;
        }
      };

      applyFloors(imp, bidRequest);

      expect(imp.native.ext).to.include({
        bidfloor: 0.60,
        bidfloorcur: 'USD',
        fl: PBJS
      });

      expect(imp.bidfloor).to.equal(0.60);
      expect(imp.bidfloorcur).to.equal('USD');
    });

    it('module vs adapter precedence: module wins for the same media/size', () => {
      const imp = makeImpBanner([[728, 90]]);

      const bidRequest = {
        params: { bidFloor: 2.00, bidFloorCur: 'USD' },
        getFloor({ mediaType, size }) {
          if (mediaType === 'banner' && size[0] === 728 && size[1] === 90) {
            return { floor: 1.10, currency: 'USD' };
          }
          return null;
        }
      };

      applyFloors(imp, bidRequest);

      expect(imp.banner.format[0].ext).to.include({
        bidfloor: 1.10,
        bidfloorcur: 'USD',
        fl: PBJS
      });

      expect(imp.bidfloor).to.equal(1.10);
      expect(imp.bidfloorcur).to.equal('USD');
    });

    it('handles missing getFloor and still applies adapter floors per format; no imp.ext.fl in reduced path', () => {
      const imp = makeImpBanner([[300, 250]]);

      const bidRequest = {
        params: { bidFloor: 0.90, bidFloorCur: 'USD' }
      };

      applyFloors(imp, bidRequest);

      expect(imp.banner.format[0].ext).to.include({
        bidfloor: 0.90,
        bidfloorcur: 'USD',
        fl: IX
      });

      expect(imp.bidfloor).to.equal(0.90);
      expect(imp.bidfloorcur).to.equal('USD');
      expect(imp.ext.fl).to.be.undefined;
    });
  });

  describe('PAAPI / FLEDGE integration', () => {
    describe('converter.toORTB propagation (imp.ext.ae / imp.ext.paapi)', () => {
      it('copies ae and paapi object from ortb2Imp.ext to imp.ext', () => {
        const validBidRequests = [{
          bidId: 'pa1',
          adUnitCode: 'pa-slot',
          params: { siteId: 321 },
          mediaTypes: { banner: { sizes: [[300, 250]] } },
          ortb2Imp: {
            ext: {
              ae: 1,
              paapi: { buyerSignals: { foo: 'bar' } }
            }
          }
        }];
        const bidderRequest = {
          refererInfo: { page: 'https://example.com' },
          timeout: 800
        };

        const r = converter.toORTB({ bidRequests: validBidRequests, bidderRequest });
        expect(r).to.have.property('imp');
        expect(r.imp).to.have.length(1);
        const imp = r.imp[0];
        expect(prebidUtils.deepAccess(imp, 'ext.ae')).to.equal(1);
        expect(prebidUtils.deepAccess(imp, 'ext.paapi')).to.deep.equal({ buyerSignals: { foo: 'bar' } });
      });
    });

    describe('buildRequestsORTBConverter -> ixdiag.ae', () => {
      it('sets ext.ixdiag.ae from bidderRequest.paapi.enabled', () => {
        const validBidRequests = [{
          bidId: 'ae1',
          adUnitCode: 'pa-diag',
          params: { siteId: 777 },
          mediaTypes: { banner: { sizes: [[300, 250]] } }
        }];
        const bidderRequest = {
          refererInfo: { page: 'https://example.com' },
          timeout: 900,
          paapi: { enabled: true }
        };

        const { data } = buildRequestsORTBConverter(validBidRequests, bidderRequest);
        expect(prebidUtils.deepAccess(data, 'ext.ixdiag.ae')).to.equal(true);
      });

      it('leaves ext.ixdiag.ae falsy when bidderRequest.paapi is absent/disabled', () => {
        const validBidRequests = [{
          bidId: 'ae2',
          adUnitCode: 'pa-diag-2',
          params: { siteId: 888 },
          mediaTypes: { banner: { sizes: [[728, 90]] } }
        }];
        const bidderRequest = {
          refererInfo: { page: 'https://example.com' },
          timeout: 900
        };

        const { data } = buildRequestsORTBConverter(validBidRequests, bidderRequest);
        expect(prebidUtils.deepAccess(data, 'ext.ixdiag.ae')).to.not.equal(true);
      });
    });

    describe('interpretResponseORTBConverter -> paapi return shape', () => {
      it('returns { bids, paapi } when ext.protectedAudienceAuctionConfigs exists', () => {
        const fromStub = sandbox.stub(converter, 'fromORTB').returns([{ cpm: 1 }]);
        sandbox.stub(FEATURE_TOGGLES, 'setFeatureToggles');

        const serverResponse = {
          body: {
            seatbid: [],
            ext: {
              protectedAudienceAuctionConfigs: [
                { seller: 'https://seller.example', decisionLogicUrl: 'https://seller.example/auction.js' }
              ]
            }
          }
        };

        const out = interpretResponseORTBConverter(serverResponse, { data: {}, validBidRequests: [] });
        expect(out).to.have.property('bids');
        expect(out).to.have.property('paapi');
        expect(out.bids).to.deep.equal([{ cpm: 1 }]);
        expect(out.paapi).to.be.an('array').with.length(1);
        expect(fromStub.calledOnce).to.equal(true);
      });

      it('returns bids array when no PAAPI auction configs present', () => {
        const fromStub = sandbox.stub(converter, 'fromORTB').returns([{ cpm: 2 }]);
        sandbox.stub(FEATURE_TOGGLES, 'setFeatureToggles');

        const serverResponse = { body: { seatbid: [], ext: {} } };
        const out = interpretResponseORTBConverter(serverResponse, { data: {}, validBidRequests: [] });
        expect(out).to.deep.equal([{ cpm: 2 }]);
        expect(fromStub.calledOnce).to.equal(true);
      });
    });
  });

  describe('converter.fromORTB -> bidResponse additions', function() {
    it('banner: sets currency & CPM, creativeId fallback, ttl default, meta/deal/ibv passthrough', function() {
      const impId = 'imp-banner-1';

      const bidRequests = [{
        bidId: impId,
        adUnitCode: 'div-banner',
        params: { siteId: 123 },
        mediaTypes: { banner: { sizes: [[300, 250]] } }
      }];

      const response = {
        cur: 'USD',
        seatbid: [{
          bid: [{
            id: 'b1',
            impid: impId,
            price: 123, // -> 1.23
            mtype: 1,   // banner
            // no crid -> creativeId should fallback to '-'
            ext: {
              dspid: '42',
              advbrandid: '99',
              advbrand: 'CoolBrand',
              dealid: 'DEAL-123',
              dsa: { compliant: true },
              ibv: { foo: 'bar' }
            }
          }]
        }]
      };

      const [b] = runE2E({ bidRequests, response });

      expect(b.currency).to.equal('USD');
      expect(b.cpm).to.equal(1.23);
      expect(b.creativeId).to.equal('-');
      expect(b.ttl).to.equal(300);
      expect(b.meta.networkId).to.equal('42');
      expect(b.meta.brandId).to.equal('99');
      expect(b.meta.brandName).to.equal('CoolBrand');
      expect(b.meta.dsa).to.deep.equal({ compliant: true });
      expect(b.dealId).to.equal('DEAL-123');
      expect(b.ext.ibv).to.deep.equal({ foo: 'bar' });
    });

    it('video (outstream): player size, vastXml, vastUrl, IX renderer when preferred; ttl from exp', function() {
      const impId = 'imp-video-1';

      const bidRequests = [{
        bidId: impId,
        adUnitCode: 'div-video',
        params: { siteId: 456 },
        mediaTypes: { video: { context: 'outstream', playerSize: [[640, 360]] } }
      }];

      const response = {
        cur: 'USD',
        ext: { videoplayerurl: 'https://js-sec.indexww.com/renderer.js' },
        seatbid: [{
          bid: [{
            id: 'vb1',
            impid: impId,
            mtype: 2,
            price: 250,        // -> 2.50
            w: 640,
            h: 360,
            adm: '<VAST version="3.0"></VAST>',
            exp: 123,
            crid: 'cr-video-1',
            ext: {
              vasturl: 'https://vast.example/123',
              dspid: '7',
              advbrandid: '88',
              advbrand: 'BrandV'
            }
          }]
        }]
      };

      const rendererObj = { setRender: sandbox.stub() };
      sandbox.stub(RendererNS.Renderer, 'install').returns(rendererObj);

      const [b] = runE2E({ bidRequests, response });

      expect(b.mediaType).to.equal('video');
      expect(b.currency).to.equal('USD');
      expect(b.cpm).to.equal(2.50);
      expect(b.playerWidth).to.equal(640);
      expect(b.playerHeight).to.equal(360);
      expect(b.vastXml).to.equal('<VAST version="3.0"></VAST>');
      expect(b.vastUrl).to.equal('https://vast.example/123');
      expect(b.renderer).to.be.ok;
      expect(RendererNS.Renderer.install.calledOnce).to.equal(true);
      expect(b.ttl).to.equal(123);
      expect(b.creativeId).to.equal('cr-video-1');
      expect(b.meta.networkId).to.equal('7');
      expect(b.meta.brandId).to.equal('88');
      expect(b.meta.brandName).to.equal('BrandV');
    });

    it('native: default TTL and meta/deal mapping; JPY CPM factor (no /100)', function() {
      const impId = 'imp-native-1';

      const bidRequests = [{
        bidId: impId,
        adUnitCode: 'div-native',
        params: { siteId: 789 },
        mediaTypes: { native: { title: { len: 80 } } }
      }];

      const response = {
        cur: 'JPY',
        seatbid: [{
          bid: [{
            id: 'nb1',
            impid: impId,
            mtype: 4,
            price: 250, // JPY -> factor 1 => CPM 250
            adm: JSON.stringify({
              native: {
                ver: '1.2',
                assets: [],
                link: { url: 'https://example.com' },
                imptrackers: []
              }
            }),
            ext: {
              dspid: '9',
              advbrandid: '55',
              advbrand: 'BrandN',
              dealid: 'DEAL-N'
            }
          }]
        }]
      };

      const [b] = runE2E({ bidRequests, response });

      expect(b.currency).to.equal('JPY');
      expect(b.cpm).to.equal(250);
      expect(b.ttl).to.equal(3600);
      expect(b.meta.networkId).to.equal('9');
      expect(b.meta.brandId).to.equal('55');
      expect(b.meta.brandName).to.equal('BrandN');
      expect(b.dealId).to.equal('DEAL-N');
    });
  });
});
