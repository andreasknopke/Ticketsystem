'use strict';

const DEFAULT_MAX_ATTACHMENT_SIZE_BYTES = 5 * 1024 * 1024;
const DEFAULT_MAX_FILES = 5;

function noopUpload(req, res, next) {
  return next();
}

function createMemoryUploadMiddleware(multer, options) {
  const config = options || {};
  if (!multer) {
    return noopUpload;
  }

  return multer({
    storage: multer.memoryStorage(),
    limits: {
      fileSize: config.maxAttachmentSizeBytes || DEFAULT_MAX_ATTACHMENT_SIZE_BYTES,
      files: config.maxFiles || DEFAULT_MAX_FILES
    },
    fileFilter(req, file, callback) {
      if (!file || !file.mimetype) {
        return callback(null, false);
      }
      return callback(null, true);
    }
  }).array(config.fieldName || 'attachments', config.maxFiles || DEFAULT_MAX_FILES);
}

function createStepsRouter(dependencies) {
  const deps = dependencies || {};
  if (!deps.express) {
    throw new Error('express dependency is required to create the steps router.');
  }
  if (!deps.stepsController) {
    throw new Error('stepsController dependency is required to create the steps router.');
  }

  const router = deps.express.Router({ mergeParams: true });
  const upload = deps.uploadMiddleware || createMemoryUploadMiddleware(deps.multer, deps);
  const controller = deps.stepsController;

  router.get('/', controller.list);
  router.post('/', upload, controller.create);
  router.get('/:stepId', controller.get);
  router.put('/:stepId', upload, controller.update);
  router.delete('/:stepId', controller.remove);
  router.get('/:stepId/attachments/:blobId', controller.downloadAttachment);

  return router;
}

module.exports = createStepsRouter;
module.exports.createStepsRouter = createStepsRouter;
module.exports.createMemoryUploadMiddleware = createMemoryUploadMiddleware;
module.exports.DEFAULT_MAX_ATTACHMENT_SIZE_BYTES = DEFAULT_MAX_ATTACHMENT_SIZE_BYTES;
module.exports.DEFAULT_MAX_FILES = DEFAULT_MAX_FILES;
