'use strict';

/*
 * Locates the native core executable. The public name is FroostRook.exe.
 * kiwa-native.exe is kept as a legacy fallback so older build scripts and
 * environments keep working after the rename. Environment overrides win:
 * FROOSTROOK_NATIVE, then the pre-rename KIWA_NATIVE.
 */

const fs = require('fs');
const path = require('path');

const DIR = path.join(__dirname, 'native');
const CANDIDATES = [
  process.env.FROOSTROOK_NATIVE,
  process.env.KIWA_NATIVE,
  path.join(DIR, 'FroostRook.exe'),
  path.join(__dirname, 'FroostRook.exe'),
  path.join(DIR, 'kiwa-native.exe'),
].filter(Boolean);

module.exports = CANDIDATES.find(p => fs.existsSync(p)) || CANDIDATES[CANDIDATES.length - 1];
