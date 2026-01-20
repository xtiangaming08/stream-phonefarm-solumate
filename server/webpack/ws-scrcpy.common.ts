import nodeExternals from 'webpack-node-externals';
import fs from 'fs';
import path from 'path';
import webpack from 'webpack';
import GeneratePackageJsonPlugin from '@dead50f7/generate-package-json-webpack-plugin';
import { mergeWithDefaultConfig } from './build.config.utils';

export const PROJECT_ROOT = path.resolve(__dirname, '..');
export const SERVER_DIST_PATH = path.join(PROJECT_ROOT, 'dist');
const PACKAGE_JSON = path.join(PROJECT_ROOT, 'package.json');

const override = path.join(PROJECT_ROOT, '/build.config.override.json');
const buildConfigOptions = mergeWithDefaultConfig(override);
const buildConfigDefinePlugin = new webpack.DefinePlugin({
    '__PATHNAME__': JSON.stringify(buildConfigOptions.PATHNAME),
});

export const common = () => {
    return {
        module: {
            rules: [
                {
                    test: /\.tsx?$/,
                    use: [
                        { loader: 'ts-loader' },
                        {
                            loader: 'ifdef-loader',
                            options: buildConfigOptions,
                        },
                    ],
                    exclude: /node_modules/,
                },
                {
                    test: /\.svg$/,
                    loader: 'svg-inline-loader',
                },
                {
                    test: /\.(png|jpe?g|gif)$/i,
                    use: [{ loader: 'file-loader' }],
                },
                {
                    test: /\.(asset)$/i,
                    use: [
                        {
                            loader: 'file-loader',
                            options: { name: '[name]' },
                        },
                    ],
                },
                {
                    test: /LICENSE$/,
                    use: [
                        {
                            loader: 'file-loader',
                            options: { name: '[path][name]' },
                        },
                    ],
                },
                {
                    test: /\.jar$/,
                    use: [
                        {
                            loader: 'file-loader',
                            options: { name: '[path][name].[ext]' },
                        },
                    ],
                },
            ],
        },
        resolve: {
            extensions: ['.tsx', '.ts', '.js'],
        },
        plugins: [buildConfigDefinePlugin],
    };
};

const packageJson = JSON.parse(fs.readFileSync(PACKAGE_JSON).toString());
const { name, version, description, author, license, scripts } = packageJson;
const basePackage = { name, version, description, author, license, scripts };

delete packageJson.dependencies;
delete packageJson.devDependencies;

const back: webpack.Configuration = {
    entry: path.join(PROJECT_ROOT, './src/server/index.ts'),
    externals: [nodeExternals()],
    plugins: [new GeneratePackageJsonPlugin(basePackage), buildConfigDefinePlugin],
    node: {
        global: false,
        __filename: false,
        __dirname: false,
    },
    output: {
        filename: 'index.js',
        path: SERVER_DIST_PATH,
    },
    target: 'node',
};

export const backend = () => {
    return Object.assign({}, common(), back);
};
