import { backend } from './ws-scrcpy.common';
import webpack from 'webpack';

const devOpts: webpack.Configuration = {
    devtool: 'inline-source-map',
    mode: 'development',
};

const back = () => {
    return Object.assign({}, backend(), devOpts);
};

module.exports = back;
