import { constants as osConstants } from './os';
import { constants as cryptoConstants } from './crypto';
import { constants as zlibConstants } from './zlib';
import { constants as bufferConstants } from './buffer';
import { constants as http2Constants } from './http2';

const fsConstants = {
  F_OK: 0,
  R_OK: 4,
  W_OK: 2,
  X_OK: 1,
};

const constants = {
  ...fsConstants,
  ...osConstants.signals,
  ...osConstants.errno,
  ...cryptoConstants,
  ...zlibConstants,
  ...bufferConstants,
  ...http2Constants,
};

export default constants;
