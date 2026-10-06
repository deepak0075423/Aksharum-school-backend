'use strict';
/**
 * A teacher's "father's / husband's name" is one field, asked for by gender
 * (Oct 2026): a man gives his father's name, a woman her father's or her
 * husband's. Other, or no gender chosen yet, keeps the combined label.
 *
 * Same wording on the web (src/utils/fatherOrHusband.js) and in the app
 * (utils/fatherOrHusband.ts).
 *
 *   fatherOrHusbandLabel('Male')                 → "Father's Name"
 *   fatherOrHusbandLabel('Female', 'sentence')   → "Father's / husband's name"
 */
const fatherOrHusbandLabel = (gender, style = 'title') => {
    const label = gender === 'Male' ? "Father's Name" : "Father's / Husband's Name";
    return style === 'sentence' ? label[0] + label.slice(1).toLowerCase() : label;
};

module.exports = { fatherOrHusbandLabel };
