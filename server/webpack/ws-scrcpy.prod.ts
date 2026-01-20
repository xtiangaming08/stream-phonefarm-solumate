import { backend } from './ws-scrcpy.common';
import webpack from 'webpack';

const prodOpts: webpack.Configuration = {
    mode: 'production',
};

const back = () => {
    return Object.assign({}, backend(), prodOpts);
};

module.exports = back;
