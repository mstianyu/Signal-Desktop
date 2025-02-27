// Copyright 2019-2020 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

/* eslint-disable no-console */
import { createWriteStream, statSync } from 'fs';
import { pathExists } from 'fs-extra';
import { readdir, writeFile } from 'fs/promises';
import { promisify } from 'util';
import { execFile } from 'child_process';
import { join, normalize, extname } from 'path';
import { tmpdir } from 'os';
import { throttle } from 'lodash';

import type { ParserConfiguration } from 'dashdash';
import { createParser } from 'dashdash';
import { FAILSAFE_SCHEMA, safeLoad } from 'js-yaml';
import { gt } from 'semver';
import config from 'config';
import got from 'got';
import { v4 as getGuid } from 'uuid';
import pify from 'pify';
import mkdirp from 'mkdirp';
import rimraf from 'rimraf';
import type { BrowserWindow } from 'electron';
import { app, ipcMain } from 'electron';

import * as durations from '../util/durations';
import { getTempPath, getUpdateCachePath } from '../util/attachments';
import { DialogType } from '../types/Dialogs';
import * as Errors from '../types/errors';
import { isAlpha, isBeta } from '../util/version';
import { strictAssert } from '../util/assert';

import * as packageJson from '../../package.json';
import {
  hexToBinary,
  verifySignature,
  getSignatureFileName,
} from './signature';
import { isPathInside } from '../util/isPathInside';
import type { SettingsChannel } from '../main/settingsChannel';

import type { LoggerType } from '../types/Logging';
import { getGotOptions } from './got';
import { checkIntegrity } from './util';
import type { PrepareDownloadResultType as DifferentialDownloadDataType } from './differential';
import {
  prepareDownload as prepareDifferentialDownload,
  download as downloadDifferentialData,
  getBlockMapFileName,
  isValidPreparedData as isValidDifferentialData,
} from './differential';

const mkdirpPromise = pify(mkdirp);
const rimrafPromise = pify(rimraf);

const INTERVAL = 30 * durations.MINUTE;

type JSONUpdateSchema = {
  version: string;
  files: Array<{
    url: string;
    sha512: string;
    size: string;
    blockMapSize?: string;
  }>;
  path: string;
  sha512: string;
  releaseDate: string;
};

export type UpdateInformationType = {
  fileName: string;
  size: number;
  version: string;
  sha512: string;
  differentialData: DifferentialDownloadDataType | undefined;
};

enum DownloadMode {
  DifferentialOnly = 'DifferentialOnly',
  FullOnly = 'FullOnly',
  Automatic = 'Automatic',
}

export abstract class Updater {
  protected fileName: string | undefined;

  protected version: string | undefined;

  protected cachedDifferentialData: DifferentialDownloadDataType | undefined;

  private throttledSendDownloadingUpdate: (downloadedSize: number) => void;

  constructor(
    protected readonly logger: LoggerType,
    private readonly settingsChannel: SettingsChannel,
    protected readonly getMainWindow: () => BrowserWindow | undefined
  ) {
    this.throttledSendDownloadingUpdate = throttle((downloadedSize: number) => {
      const mainWindow = this.getMainWindow();
      mainWindow?.webContents.send(
        'show-update-dialog',
        DialogType.Downloading,
        { downloadedSize }
      );
    }, 500);
  }

  //
  // Public APIs
  //

  public async force(): Promise<void> {
    return this.checkForUpdatesMaybeInstall(true);
  }

  public async start(): Promise<void> {
    this.logger.info('updater/start: starting checks...');

    setInterval(async () => {
      try {
        await this.checkForUpdatesMaybeInstall();
      } catch (error) {
        this.logger.error(`updater/start: ${Errors.toLogFormat(error)}`);
      }
    }, INTERVAL);

    await this.deletePreviousInstallers();
    await this.checkForUpdatesMaybeInstall();
  }

  //
  // Abstract methods
  //

  protected abstract deletePreviousInstallers(): Promise<void>;

  protected abstract installUpdate(updateFilePath: string): Promise<void>;

  //
  // Protected methods
  //

  protected setUpdateListener(
    performUpdateCallback: () => Promise<void>
  ): void {
    ipcMain.removeHandler('start-update');
    ipcMain.handleOnce('start-update', performUpdateCallback);
  }

  //
  // Private methods
  //

  private async downloadAndInstall(
    updateInfo: UpdateInformationType,
    mode: DownloadMode
  ): Promise<boolean> {
    const { logger } = this;

    const { fileName: newFileName, version: newVersion } = updateInfo;

    try {
      const oldVersion = this.version;

      this.version = newVersion;

      let updateFilePath: string | undefined;
      try {
        updateFilePath = await this.downloadUpdate(updateInfo, mode);
      } catch (error) {
        // Restore state in case of download error
        this.version = oldVersion;
        throw error;
      }

      if (!updateFilePath) {
        logger.warn('downloadAndInstall: no update was downloaded');
        strictAssert(
          mode !== DownloadMode.Automatic && mode !== DownloadMode.FullOnly,
          'Automatic and full mode downloads are guaranteed to happen or error'
        );
        return false;
      }

      const publicKey = hexToBinary(config.get('updatesPublicKey'));
      const verified = await verifySignature(
        updateFilePath,
        this.version,
        publicKey
      );
      if (!verified) {
        // Note: We don't delete the cache here, because we don't want to continually
        //   re-download the broken release. We will download it only once per launch.
        throw new Error(
          'Downloaded update did not pass signature verification ' +
            `(version: '${this.version}'; fileName: '${newFileName}')`
        );
      }

      await this.installUpdate(updateFilePath);

      const mainWindow = this.getMainWindow();
      if (mainWindow) {
        mainWindow.webContents.send('show-update-dialog', DialogType.Update, {
          version: this.version,
        });
      } else {
        logger.warn(
          'downloadAndInstall: no mainWindow, cannot show update dialog'
        );
      }

      return true;
    } catch (error) {
      logger.error(`downloadAndInstall: ${Errors.toLogFormat(error)}`);
      throw error;
    }
  }

  private async checkForUpdatesMaybeInstall(force = false): Promise<void> {
    const { logger } = this;

    logger.info('checkForUpdatesMaybeInstall: checking for update...');
    const updateInfo = await this.checkForUpdates(force);
    if (!updateInfo) {
      return;
    }

    const { version: newVersion } = updateInfo;

    if (!force && this.version && !gt(newVersion, this.version)) {
      return;
    }

    const autoDownloadUpdates = await this.getAutoDownloadUpdateSetting();
    if (autoDownloadUpdates) {
      await this.downloadAndInstall(updateInfo, DownloadMode.Automatic);
      return;
    }

    let mode = DownloadMode.FullOnly;
    if (updateInfo.differentialData) {
      mode = DownloadMode.DifferentialOnly;
    }

    await this.offerUpdate(updateInfo, mode, 0);
  }

  private async offerUpdate(
    updateInfo: UpdateInformationType,
    mode: DownloadMode,
    attempt: number
  ): Promise<void> {
    const { logger } = this;

    this.setUpdateListener(async () => {
      logger.info('offerUpdate: have not downloaded update, going to download');

      const didDownload = await this.downloadAndInstall(updateInfo, mode);
      if (!didDownload && mode === DownloadMode.DifferentialOnly) {
        this.logger.warn(
          'offerUpdate: Failed to download differential update, offering full'
        );

        return this.offerUpdate(updateInfo, DownloadMode.FullOnly, attempt + 1);
      }

      strictAssert(didDownload, 'FullOnly must always download update');
    });

    const mainWindow = this.getMainWindow();
    if (!mainWindow) {
      logger.warn('offerUpdate: no mainWindow, cannot show update dialog');
      return;
    }

    let downloadSize: number;
    if (mode === DownloadMode.DifferentialOnly) {
      strictAssert(
        updateInfo.differentialData,
        'Must have differential data in DifferentialOnly mode'
      );
      downloadSize = updateInfo.differentialData.downloadSize;
    } else {
      downloadSize = updateInfo.size;
    }

    logger.info(`offerUpdate: offering ${mode} update`);
    mainWindow.webContents.send(
      'show-update-dialog',
      attempt === 0 ? DialogType.DownloadReady : DialogType.FullDownloadReady,
      {
        downloadSize,
        downloadMode: mode,
        version: updateInfo.version,
      }
    );
  }

  private async checkForUpdates(
    forceUpdate = false
  ): Promise<UpdateInformationType | undefined> {
    const yaml = await getUpdateYaml();
    const parsedYaml = parseYaml(yaml);
    const version = getVersion(parsedYaml);

    if (!version) {
      this.logger.warn(
        'checkForUpdates: no version extracted from downloaded yaml'
      );

      return;
    }

    if (!forceUpdate && !isVersionNewer(version)) {
      this.logger.info(
        `checkForUpdates: ${version} is not newer than ${packageJson.version}; ` +
          'no new update available'
      );

      return;
    }

    this.logger.info(
      `checkForUpdates: found newer version ${version} ` +
        `forceUpdate=${forceUpdate}`
    );

    const fileName = getUpdateFileName(
      parsedYaml,
      process.platform,
      await this.getArch()
    );

    const sha512 = getSHA512(parsedYaml, fileName);
    strictAssert(sha512 !== undefined, 'Missing required hash');

    const latestInstaller = await this.getLatestCachedInstaller(
      extname(fileName)
    );

    let differentialData: DifferentialDownloadDataType | undefined;
    if (latestInstaller) {
      this.logger.info(
        `checkForUpdates: Found local installer ${latestInstaller}`
      );

      const diffOptions = {
        oldFile: latestInstaller,
        newUrl: `${getUpdatesBase()}/${fileName}`,
        sha512,
      };

      if (
        this.cachedDifferentialData &&
        isValidDifferentialData(this.cachedDifferentialData, diffOptions)
      ) {
        this.logger.info('checkForUpdates: using cached differential data');

        differentialData = this.cachedDifferentialData;
      } else {
        try {
          differentialData = await prepareDifferentialDownload(diffOptions);

          this.cachedDifferentialData = differentialData;

          this.logger.info(
            'checkForUpdates: differential download size',
            differentialData.downloadSize
          );
        } catch (error) {
          this.logger.error(
            'checkForUpdates: Failed to prepare differential update',
            Errors.toLogFormat(error)
          );
          this.cachedDifferentialData = undefined;
        }
      }
    }

    return {
      fileName,
      size: getSize(parsedYaml, fileName),
      version,
      sha512,
      differentialData,
    };
  }

  private async getLatestCachedInstaller(
    extension: string
  ): Promise<string | undefined> {
    const cacheDir = await createUpdateCacheDirIfNeeded();
    const oldFiles = (await readdir(cacheDir)).map(fileName => {
      return join(cacheDir, fileName);
    });

    return oldFiles.find(fileName => extname(fileName) === extension);
  }

  private async downloadUpdate(
    { fileName, sha512, differentialData }: UpdateInformationType,
    mode: DownloadMode
  ): Promise<string | undefined> {
    const baseUrl = getUpdatesBase();
    const updateFileUrl = `${baseUrl}/${fileName}`;

    const updateOnProgress = mode !== DownloadMode.Automatic;

    const signatureFileName = getSignatureFileName(fileName);
    const blockMapFileName = getBlockMapFileName(fileName);
    const signatureUrl = `${baseUrl}/${signatureFileName}`;
    const blockMapUrl = `${baseUrl}/${blockMapFileName}`;

    const cacheDir = await createUpdateCacheDirIfNeeded();
    const targetUpdatePath = join(cacheDir, fileName);
    const targetSignaturePath = join(cacheDir, signatureFileName);
    const targetBlockMapPath = join(cacheDir, blockMapFileName);

    const targetPaths = [
      targetUpdatePath,
      targetSignaturePath,
      targetBlockMapPath,
    ];

    // List of files to be deleted on success
    const oldFiles = (await readdir(cacheDir))
      .map(oldFileName => {
        return join(cacheDir, oldFileName);
      })
      .filter(path => !targetPaths.includes(path));

    try {
      validatePath(cacheDir, targetUpdatePath);
      validatePath(cacheDir, targetSignaturePath);
      validatePath(cacheDir, targetBlockMapPath);

      this.logger.info(`downloadUpdate: Downloading signature ${signatureUrl}`);
      const signature = await got(signatureUrl, getGotOptions()).buffer();
      await writeFile(targetSignaturePath, signature);

      if (differentialData) {
        this.logger.info(`downloadUpdate: Saving blockmap ${blockMapUrl}`);
        await writeFile(targetBlockMapPath, differentialData.newBlockMap);
      } else {
        try {
          this.logger.info(
            `downloadUpdate: Downloading blockmap ${blockMapUrl}`
          );
          const blockMap = await got(blockMapUrl, getGotOptions()).buffer();
          await writeFile(targetBlockMapPath, blockMap);
        } catch (error) {
          this.logger.warn(
            'downloadUpdate: Failed to download blockmap, continuing',
            Errors.toLogFormat(error)
          );
        }
      }

      let gotUpdate = false;
      if (!gotUpdate && (await pathExists(targetUpdatePath))) {
        const checkResult = await checkIntegrity(targetUpdatePath, sha512);
        if (checkResult.ok) {
          this.logger.info(
            `downloadUpdate: Not downloading update ${updateFileUrl}, ` +
              'local file has the same hash'
          );
          gotUpdate = true;
        } else {
          this.logger.error(
            'downloadUpdate: integrity check failure',
            checkResult.error
          );
        }
      }

      const isDifferentialEnabled =
        differentialData && mode !== DownloadMode.FullOnly;
      if (!gotUpdate && isDifferentialEnabled) {
        this.logger.info(
          `downloadUpdate: Downloading differential update ${updateFileUrl}`
        );

        try {
          await downloadDifferentialData(targetUpdatePath, differentialData, {
            statusCallback: updateOnProgress
              ? this.throttledSendDownloadingUpdate
              : undefined,
            logger: this.logger,
          });

          gotUpdate = true;
        } catch (error) {
          this.logger.error(
            'downloadUpdate: Failed to apply differential update',
            Errors.toLogFormat(error)
          );
        }
      }

      const isFullEnabled = mode !== DownloadMode.DifferentialOnly;
      if (!gotUpdate && isFullEnabled) {
        this.logger.info(
          `downloadUpdate: Downloading full update ${updateFileUrl}`
        );
        await this.downloadAndReport(
          updateFileUrl,
          targetUpdatePath,
          updateOnProgress
        );
        gotUpdate = true;
      }

      if (!gotUpdate) {
        return undefined;
      }

      // Now that we successfully downloaded an update - remove old files
      await Promise.all(oldFiles.map(path => rimrafPromise(path)));

      return targetUpdatePath;
    } catch (error) {
      try {
        await Promise.all([targetPaths.map(path => rimrafPromise(path))]);
      } catch (_) {
        // Ignore error, this is a cleanup
      }
      throw error;
    }
  }

  private async downloadAndReport(
    updateFileUrl: string,
    targetUpdatePath: string,
    updateOnProgress = false
  ): Promise<void> {
    const downloadStream = got.stream(updateFileUrl, getGotOptions());
    const writeStream = createWriteStream(targetUpdatePath);

    await new Promise<void>((resolve, reject) => {
      if (updateOnProgress) {
        let downloadedSize = 0;

        downloadStream.on('data', data => {
          downloadedSize += data.length;
          this.throttledSendDownloadingUpdate(downloadedSize);
        });
      }

      downloadStream.on('error', error => {
        reject(error);
      });
      downloadStream.on('end', () => {
        resolve();
      });

      writeStream.on('error', error => {
        reject(error);
      });

      downloadStream.pipe(writeStream);
    });
  }

  private async getAutoDownloadUpdateSetting(): Promise<boolean> {
    try {
      return await this.settingsChannel.getSettingFromMainWindow(
        'autoDownloadUpdate'
      );
    } catch (error) {
      this.logger.warn(
        'getAutoDownloadUpdateSetting: Failed to fetch, returning false',
        Errors.toLogFormat(error)
      );
      return false;
    }
  }

  private async getArch(): Promise<typeof process.arch> {
    if (process.platform !== 'darwin' || process.arch === 'arm64') {
      return process.arch;
    }

    try {
      // We might be running under Rosetta
      const flag = 'sysctl.proc_translated';
      const { stdout } = await promisify(execFile)('sysctl', ['-i', flag]);

      if (stdout.includes(`${flag}: 1`)) {
        this.logger.info('updater: running under Rosetta');
        return 'arm64';
      }
    } catch (error) {
      this.logger.warn(
        `updater: Rosetta detection failed with ${Errors.toLogFormat(error)}`
      );
    }

    this.logger.info('updater: not running under Rosetta');
    return process.arch;
  }
}

export function validatePath(basePath: string, targetPath: string): void {
  const normalized = normalize(targetPath);

  if (!isPathInside(normalized, basePath)) {
    throw new Error(
      `validatePath: Path ${normalized} is not under base path ${basePath}`
    );
  }
}

// Helper functions

export function getUpdateCheckUrl(): string {
  return `${getUpdatesBase()}/${getUpdatesFileName()}`;
}

export function getUpdatesBase(): string {
  return config.get('updatesUrl');
}

export function getUpdatesFileName(): string {
  const prefix = getChannel();

  if (process.platform === 'darwin') {
    return `${prefix}-mac.yml`;
  }

  return `${prefix}.yml`;
}

function getChannel(): string {
  const { version } = packageJson;

  if (isAlpha(version)) {
    return 'alpha';
  }
  if (isBeta(version)) {
    return 'beta';
  }
  return 'latest';
}

function isVersionNewer(newVersion: string): boolean {
  const { version } = packageJson;

  return gt(newVersion, version);
}

export function getVersion(info: JSONUpdateSchema): string | null {
  return info && info.version;
}

const validFile = /^[A-Za-z0-9.-]+$/;
export function isUpdateFileNameValid(name: string): boolean {
  return validFile.test(name);
}

export function getUpdateFileName(
  info: JSONUpdateSchema,
  platform: typeof process.platform,
  arch: typeof process.arch
): string {
  if (!info || !info.path) {
    throw new Error('getUpdateFileName: No path present in YAML file');
  }

  let path: string | undefined;
  if (platform === 'darwin') {
    const { files } = info;

    const candidates = files.filter(
      ({ url }) => url.includes(arch) && url.endsWith('.zip')
    );

    if (candidates.length === 1) {
      path = candidates[0].url;
    }
  }

  path = path ?? info.path;

  if (!isUpdateFileNameValid(path)) {
    throw new Error(
      `getUpdateFileName: Path '${path}' contains invalid characters`
    );
  }

  return path;
}

function getSHA512(
  info: JSONUpdateSchema,
  fileName: string
): string | undefined {
  if (!info || !info.files) {
    throw new Error('getSHA512: No files present in YAML file');
  }

  const foundFile = info.files.find(file => file.url === fileName);

  return foundFile?.sha512;
}

function getSize(info: JSONUpdateSchema, fileName: string): number {
  if (!info || !info.files) {
    throw new Error('getSize: No files present in YAML file');
  }

  const foundFile = info.files.find(file => file.url === fileName);

  return Number(foundFile?.size) || 0;
}

export function parseYaml(yaml: string): JSONUpdateSchema {
  return safeLoad(yaml, { schema: FAILSAFE_SCHEMA, json: true });
}

async function getUpdateYaml(): Promise<string> {
  const targetUrl = getUpdateCheckUrl();
  const body = await got(targetUrl, getGotOptions()).text();

  if (!body) {
    throw new Error('Got unexpected response back from update check');
  }

  return body;
}

function getBaseTempDir() {
  // We only use tmpdir() when this code is run outside of an Electron app (as in: tests)
  return app ? getTempPath(app.getPath('userData')) : tmpdir();
}

export async function createTempDir(): Promise<string> {
  const baseTempDir = getBaseTempDir();
  const uniqueName = getGuid();
  const targetDir = join(baseTempDir, uniqueName);
  await mkdirpPromise(targetDir);

  return targetDir;
}

function getUpdateCacheDir() {
  // We only use tmpdir() when this code is run outside of an Electron app (as in: tests)
  return app ? getUpdateCachePath(app.getPath('userData')) : tmpdir();
}

export async function createUpdateCacheDirIfNeeded(): Promise<string> {
  const targetDir = getUpdateCacheDir();
  await mkdirpPromise(targetDir);

  return targetDir;
}

export async function deleteTempDir(targetDir: string): Promise<void> {
  const pathInfo = statSync(targetDir);
  if (!pathInfo.isDirectory()) {
    throw new Error(
      `deleteTempDir: Cannot delete path '${targetDir}' because it is not a directory`
    );
  }

  const baseTempDir = getBaseTempDir();
  if (!isPathInside(targetDir, baseTempDir)) {
    throw new Error(
      `deleteTempDir: Cannot delete path '${targetDir}' since it is not within base temp dir`
    );
  }

  await rimrafPromise(targetDir);
}

export function getCliOptions<T>(options: ParserConfiguration['options']): T {
  const parser = createParser({ options });
  const cliOptions = parser.parse(process.argv);

  if (cliOptions.help) {
    const help = parser.help().trimRight();
    console.log(help);
    process.exit(0);
  }

  return cliOptions as unknown as T;
}
