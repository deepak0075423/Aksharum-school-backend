'use strict';
// Public surface of the timetable generation service. Controllers import from
// here only — the engine internals stay swappable.

const types = require('./types');
const rng = require('./rng');
const engine = require('./engine');
const validator = require('./validator');
const dataLoader = require('./dataLoader');
const constraints = require('./constraints');

module.exports = {
    ...types,
    createRng: rng.createRng,
    newSeed: rng.newSeed,
    generate: engine.generate,
    compile: engine.compile,
    preflight: engine.preflight,
    validate: validator.validate,
    validateMove: validator.validateMove,
    loadGenerationInput: dataLoader.loadGenerationInput,
    resolveScope: dataLoader.resolveScope,
    derivePeriods: dataLoader.derivePeriods,
    normalisePeriods: dataLoader.normalisePeriods,
    constraints,
};
