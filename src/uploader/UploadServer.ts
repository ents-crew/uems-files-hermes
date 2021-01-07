import { Express, Request, RequestHandler, Response } from "express";
import { FileResponse } from "@uems/uemscommlib";
import InternalFile = FileResponse.InternalFile;
import path from "path";
import * as fs from "fs";
import express from 'express';
import multer from "multer";
import urljoin from 'url-join'
import { DatabaseFile } from "../database/FileDatabase";
import { UploadConfiguration } from "../ConfigurationTypes";
import { _ml } from "../logging/Log";
import fileUpload, { UploadedFile } from "express-fileupload";
import bodyParser from "body-parser";
import { FileHandle } from "fs/promises";

const __ = _ml(__filename);

export const kb = (n: number) => n;
export const mb = (n: number) => n * 1024;
export const gb = (n: number) => n * 1024 * 1024;

export type UpdateFunction = (filePath: string, fileName: string, mime: string) => Promise<void>;

export interface UploadServerInterface {

    launch(): Promise<void>;

    provisionUploadURI(file: InternalFile, update: UpdateFunction): Promise<string>;

    generateDownloadURI(file: DatabaseFile): Promise<string>;

    deleteFile(file: DatabaseFile): Promise<void>

}

export class LocalUploadServer implements UploadServerInterface {

    private _provisionedIDs: {
        [key: string]: {
            file: InternalFile,
            update: UpdateFunction,
        }
    } = {
        'testingID': {
            update: (filePath, fileName) => Promise.resolve(console.log(`TRYING TO UPDATE WITH ${filePath} and ${fileName}`)),
            file: {
                filename: 'name',
                type: 'something',
                // @ts-ignore
                owner: 'else',
                size: 1024,
                name: 'abc',
                id: '124',
                date: Date.now(),
                mime: 'exfdsfnjdsf',
            },
        },
    };

    private _express: Express;

    private _uploadPath: string;

    /**
     * Maximum size of the file in kilobytes
     * @private
     */
    private _maxSize: number;

    private _mimeList: string[];

    private _mimeListType: 'WHITELIST' | 'BLACKLIST' = 'WHITELIST';

    private _port: number;

    private _domain: string;


    constructor({ uploadPath, maxSize, mimeList, mimeType, port, domain }: UploadConfiguration) {
        this._uploadPath = uploadPath ?? path.join(__dirname, '..', '..', 'uploads');

        // Try and make the upload path, if it already exists it throws an EEXIST error so we can just ignore that
        try {
            fs.mkdirSync(this._uploadPath, { recursive: true });
        } catch (err) {
            if (err.code !== 'EEXIST') {
                console.error('Failed to create the upload folder for the local upload server. If the ')
                throw err;
            }
        }

        this._maxSize = maxSize ?? mb(10);
        this._mimeList = mimeList ?? [];
        this._mimeListType = mimeType ?? 'BLACKLIST';
        this._port = port ?? 1432;
        this._domain = domain;

        const storage = multer.diskStorage({
            destination: (req, file, cb) => {
                console.log('setting output path to ', this._uploadPath);
                cb(null, this._uploadPath);
            },

            filename: (req, file, cb) => {
                if (!req.params.id) {
                    cb(new Error('No ID was provided'), '');
                    return;
                }

                if (this._provisionedIDs[req.params.id] === undefined) {
                    cb(new Error('Invalid parameter'), '');
                    return;
                }


            }
        });

        const filter = (res: Response, file: UploadedFile) => {
            if (this._mimeList.includes(file.mimetype)) {
                if (this._mimeListType === 'BLACKLIST') {
                    res.json({
                        status: 'FAIL',
                        error: 'This file type is not permitted to be uploaded to this node'
                    });
                    return false;
                }
            } else {
                if (this._mimeListType === 'WHITELIST') {
                    res.json({
                        status: 'FAIL',
                        error: 'This file type is not permitted to be uploaded to this node'
                    });
                    return false;
                }
            }

            return true;
        }

        this._express = express();
        this._express.use(fileUpload({
            debug: true,
        }));
        this._express.use(function(req, res, next) {
            res.header("Access-Control-Allow-Origin", "*"); // update to match the domain you will make the request from
            res.header("Access-Control-Allow-Headers", "*");
            next();
        });

        const validator: RequestHandler = (req, res, next) => {
            if (!req.params.id) {
                res.json({
                    status: 'FAIL',
                    error: 'ID parameter nto provided, this should not happen! Please report this'
                });
                return;
            }

            if (this._provisionedIDs[req.params.id] === undefined) {
                res.sendStatus(404);
                return;
            }

            next();
        }

        this._express.post('/upload/:id', validator, (req, res) => {
            if (!req.files) {
                res.json({
                    status: 'FAIL',
                    error: 'Must provide a file'
                });
                return;
            }

            if (Object.keys(req.files).length !== 1) {
                res.json({
                    status: 'FAIL',
                    error: 'Must provide only one file'
                });
                return;
            }

            if (!Object.prototype.hasOwnProperty.call(req.files, 'data')) {
                res.json({
                    status: 'FAIL',
                    error: 'File must be provided through the data parameter'
                });
                return;
            }

            // @ts-ignore
            const file: UploadedFile = req.files.data;
            const { update, file: dbs } = this._provisionedIDs[req.params.id];

            if (file.size !== dbs.size) {
                console.warn('file size not a match');
            }

            // Check the mime type is valid
            if (!filter(res, file)){
                return;
            }

            // Update the file download URL
            update('/download/' + req.params.id, file.name, file.mimetype)
                .then(() => {
                    return file.mv(path.join(this._uploadPath, req.params.id));
                })
                .then(() => {
                    res.json({
                        status: 'OK',
                    });
                })
                .catch((err) => {
                    console.log('tried to fail with error', err);
                    // @ts-ignore
                    res.json({
                        status: 'FAIL',
                        error: 'failed to finalise upload'
                    });
                });
        })
    }

    private static generateIdentifier() {
        const options = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ01234567890123456789'.split('');
        const length = 20;

        let output = '';
        for (let i = 0; i < length; i++) output += options[Math.floor(Math.random() * options.length)];

        return output;
    }

    launch(): Promise<void> {
        __.info('LocalUploadServer now available on port: ' + this._port);

        this._express.listen(this._port);
        return Promise.resolve();
    }

    provisionUploadURI(file: FileResponse.InternalFile, update: UpdateFunction): Promise<string> {
        const id = LocalUploadServer.generateIdentifier();
        this._provisionedIDs[id] = {
            update,
            file,
        };

        return Promise.resolve(urljoin(this._domain, '/upload/', id));
    }

    generateDownloadURI(file: DatabaseFile): Promise<string> {
        return Promise.resolve(urljoin(this._domain, file.filePath));
    }

    async deleteFile(file: DatabaseFile): Promise<void> {
        const filePath = path.join(this._uploadPath, file.filePath.replace('/download/', ''));
        await fs.promises.rm(filePath);
    }

}