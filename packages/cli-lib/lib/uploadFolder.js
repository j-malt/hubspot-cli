const fs = require('fs');
const path = require('path');
const yargs = require('yargs');
const { default: PQueue } = require('p-queue');
const { convertFieldsJs, handleFieldErrors } = require('./handleFieldsJs');
const { logger } = require('../logger');
const { getFileMapperQueryValues } = require('../fileMapper');
const { upload } = require('../api/fileMapper');
const { createIgnoreFilter } = require('../ignoreRules');
const { walk } = require('./walk');
const { i18n } = require('@hubspot/cli-lib/lib/lang');
const i18nKey = 'cli.commands.upload';
const escapeRegExp = require('./escapeRegExp');
const {
  convertToUnixPath,
  isAllowedExtension,
  getExt,
  splitLocalPath,
} = require('../path');
const {
  ApiErrorContext,
  logApiUploadErrorInstance,
  isFatalError,
} = require('../errorHandlers');

const FileUploadResultType = {
  SUCCESS: 'SUCCESS',
  FAILURE: 'FAILURE',
};

const queue = new PQueue({
  concurrency: 10,
});

function getFilesByType(files) {
  const moduleFiles = [];
  const cssAndJsFiles = [];
  const otherFiles = [];
  const templateFiles = [];
  const jsonFiles = [];

  files.forEach(file => {
    const parts = splitLocalPath(file);
    const extension = getExt(file);

    const moduleFolder = parts.find(part => part.endsWith('.module'));
    if (moduleFolder) {
      const fileName = parts[parts.length - 1];
      //If the folder contains a fields.js, we will always overwrite the existing fields.json.
      if (fileName === 'fields.js') {
        try {
          logger.info(
            i18n(`${i18nKey}.converting`, {
              src: moduleFolder + '/fields.js',
              dest: moduleFolder + '/fields.json',
            })
          );
          moduleFiles.push(convertFieldsJs(file, yargs.argv.options));
        } catch (e) {
          handleFieldErrors(e, file);
          throw e;
        }
      } else {
        if (getExt(file) == 'json') {
          // Don't push any JSON files that are in the modules folder besides fields & meta or the design manager will get mad.
          if (fileName == 'meta.json') {
            moduleFiles.push(file);
          }

          if (fileName === 'fields.json') {
            // If the folder contains a fields.js, then do not push the fields.json - we will push our own.
            const dir = fs
              .readdirSync(path.dirname(file), { withFileTypes: true })
              .filter(item => !item.isDirectory())
              .map(item => item.name);
            if (!dir.includes('fields.js')) {
              moduleFiles.push(file);
            }
          }
        } else {
          moduleFiles.push(file);
        }
      }
    } else if (extension === 'js' || extension === 'css') {
      cssAndJsFiles.push(file);
    } else if (extension === 'html') {
      templateFiles.push(file);
    } else if (extension === 'json') {
      jsonFiles.push(file);
    } else {
      otherFiles.push(file);
    }
  });
  return [otherFiles, moduleFiles, cssAndJsFiles, templateFiles, jsonFiles];
}
/**
 *
 * @param {number} accountId
 * @param {string} src
 * @param {string} dest
 * @param {object} options
 */
async function uploadFolder(accountId, src, dest, options) {
  const regex = new RegExp(`^${escapeRegExp(src)}`);
  const files = await walk(src);

  const allowedFiles = files
    .filter(file => {
      if (!isAllowedExtension(file)) {
        return false;
      }
      return true;
    })
    .filter(createIgnoreFilter());

  const filesByType = getFilesByType(allowedFiles);
  const apiOptions = getFileMapperQueryValues(options);

  const failures = [];

  const uploadFile = file => {
    const relativePath = file.replace(regex, '');
    const destPath = convertToUnixPath(path.join(dest, relativePath));

    return async () => {
      logger.debug('Attempting to upload file "%s" to "%s"', file, destPath);
      try {
        await upload(accountId, file, destPath, apiOptions);
        logger.log('Uploaded file "%s" to "%s"', file, destPath);
      } catch (error) {
        if (isFatalError(error)) {
          throw error;
        }
        logger.debug(
          'Uploading file "%s" to "%s" failed so scheduled retry',
          file,
          destPath
        );
        if (error.response && error.response.body) {
          logger.debug(error.response.body);
        } else {
          logger.debug(error.message);
        }
        failures.push({
          file,
          destPath,
        });
      }
    };
  };

  // Implemented using a for loop due to async/await
  for (let i = 0; i < filesByType.length; i++) {
    const filesToUpload = filesByType[i];
    await queue.addAll(filesToUpload.map(uploadFile));
  }

  const results = await queue.addAll(
    failures.map(({ file, destPath }) => {
      return async () => {
        logger.debug('Retrying to upload file "%s" to "%s"', file, destPath);
        try {
          await upload(accountId, file, destPath, apiOptions);
          logger.log('Uploaded file "%s" to "%s"', file, destPath);
          return {
            resultType: FileUploadResultType.SUCCESS,
            error: null,
            file,
          };
        } catch (error) {
          logger.error('Uploading file "%s" to "%s" failed', file, destPath);
          if (isFatalError(error)) {
            throw error;
          }
          logApiUploadErrorInstance(
            error,
            new ApiErrorContext({
              accountId,
              request: destPath,
              payload: file,
            })
          );
          return {
            resultType: FileUploadResultType.FAILURE,
            error,
            file,
          };
        }
      };
    })
  );
  return results;
}

function hasUploadErrors(results) {
  return results.some(
    result => result.resultType === FileUploadResultType.FAILURE
  );
}

module.exports = {
  hasUploadErrors,
  FileUploadResultType,
  uploadFolder,
};
