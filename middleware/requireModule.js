'use strict';
// Historical entry point: `require('../../middleware/requireModule')(key)`.
// The implementation now lives in middleware/moduleAccess.js, which layers the
// designation permission check on top of the school-level module flag.
module.exports = require('./moduleAccess').requireModule;
