'use strict';
/**
 * DigiLocker for families (services/admission/digilocker.js): connect from the
 * application page, come back through the callback, fetch issued documents.
 */
const access = require('../services/admission/access');
const digilocker = require('../services/admission/digilocker');
const { handler } = require('../services/admission/util');

const TAG = 'admission digilocker';

exports.view = handler(async (req, res) => {
    const app = await access.ownApplication(req, req.params.id);
    res.set('Cache-Control', 'no-store').json({ success: true, data: await digilocker.view(app) });
}, TAG);

exports.start = handler(async (req, res) => {
    const app = await access.ownApplication(req, req.params.id);
    res.json({ success: true, data: await digilocker.start(req, app) });
}, TAG);

exports.importFile = handler(async (req, res) => {
    const app = await access.ownApplication(req, req.params.id);
    res.status(201).json({ success: true, data: await digilocker.importFile(req, app, { uri: req.body?.uri, docKey: req.body?.docKey }) });
}, TAG);

/** DigiLocker sends the browser back here; it goes on to the application's page. */
exports.callback = async (req, res) => {
    try {
        res.redirect(303, await digilocker.callback({ code: req.query.code, state: req.query.state, error: req.query.error }));
    } catch (e) {
        console.error('[admission] digilocker callback:', e.message);
        res.redirect(303, `${String(process.env.FRONTEND_URL || 'http://localhost:3000').replace(/\/+$/, '')}/`);
    }
};
