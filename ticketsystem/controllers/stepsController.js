'use strict';

const DEFAULT_MAX_ATTACHMENT_SIZE_BYTES = 5 * 1024 * 1024;

function getModel(models, names) {
  for (const name of names) {
    if (models && models[name]) {
      return models[name];
    }
  }
  return null;
}

function getPlain(record) {
  if (!record) {
    return null;
  }
  if (typeof record.get === 'function') {
    return record.get({ plain: true });
  }
  if (typeof record.toJSON === 'function') {
    return record.toJSON();
  }
  return record;
}

function toInteger(value) {
  const parsed = Number.parseInt(value, 10);
  return Number.isNaN(parsed) ? null : parsed;
}

function normalizeFiles(req) {
  if (!req) {
    return [];
  }
  if (Array.isArray(req.files)) {
    return req.files;
  }
  if (req.files && typeof req.files === 'object') {
    return Object.keys(req.files).reduce((all, key) => all.concat(req.files[key]), []);
  }
  return req.file ? [req.file] : [];
}

function createChecksum(buffer) {
  if (!buffer) {
    return null;
  }
  try {
    const crypto = require('crypto');
    return crypto.createHash('sha256').update(buffer).digest('hex');
  } catch (error) {
    return null;
  }
}

function serializeBlobMeta(blob) {
  const plain = getPlain(blob) || {};
  return {
    id: plain.id,
    stepId: plain.stepId || plain.step_id,
    filename: plain.filename,
    mimetype: plain.mimetype,
    size: plain.size,
    checksum: plain.checksum,
    createdAt: plain.createdAt || plain.created_at
  };
}

function serializeStep(step, blobs) {
  const plain = getPlain(step) || {};
  return {
    id: plain.id,
    milestoneId: plain.milestoneId || plain.milestone_id,
    text: plain.text,
    date: plain.date,
    createdAt: plain.createdAt || plain.created_at,
    updatedAt: plain.updatedAt || plain.updated_at,
    blobs: (blobs || []).map(serializeBlobMeta)
  };
}

function validateStepPayload(body, partial) {
  const payload = body || {};
  const result = {};

  if (!partial || Object.prototype.hasOwnProperty.call(payload, 'text')) {
    const text = typeof payload.text === 'string' ? payload.text.trim() : '';
    if (!text) {
      return { error: 'text is required' };
    }
    result.text = text;
  }

  if (!partial || Object.prototype.hasOwnProperty.call(payload, 'date')) {
    const date = typeof payload.date === 'string' ? payload.date.trim() : '';
    if (!date) {
      return { error: 'date is required' };
    }
    result.date = date;
  }

  return { value: result };
}

async function createAttachments(BlobModel, stepId, files, maxAttachmentSizeBytes) {
  const created = [];
  for (const file of files) {
    const buffer = file.buffer || file.data;
    const size = file.size || (buffer ? buffer.length : 0);

    if (!buffer) {
      const error = new Error('Attachment data is missing. Configure upload middleware with in-memory storage.');
      error.status = 400;
      throw error;
    }

    if (size > maxAttachmentSizeBytes) {
      const error = new Error('Attachment exceeds the maximum size of ' + maxAttachmentSizeBytes + ' bytes.');
      error.status = 413;
      throw error;
    }

    created.push(await BlobModel.create({
      stepId,
      filename: file.originalname || file.filename || 'attachment',
      mimetype: file.mimetype || 'application/octet-stream',
      size,
      checksum: createChecksum(buffer),
      data: buffer
    }));
  }
  return created;
}

function createStepsController(models, options) {
  const config = options || {};
  const MilestoneStep = getModel(models, ['MilestoneStep', 'milestonestep', 'MilestoneSteps']);
  const BlobModel = getModel(models, ['Blob', 'blob', 'Blobs']);
  const maxAttachmentSizeBytes = config.maxAttachmentSizeBytes || DEFAULT_MAX_ATTACHMENT_SIZE_BYTES;

  if (!MilestoneStep || !BlobModel) {
    throw new Error('MilestoneStep and Blob models are required for stepsController.');
  }

  async function findStep(req, res) {
    const milestoneId = toInteger(req.params.milestoneId);
    const stepId = toInteger(req.params.stepId || req.params.id);

    if (!milestoneId || !stepId) {
      res.status(400).json({ error: 'milestoneId and stepId are required' });
      return null;
    }

    const step = await MilestoneStep.findOne({ where: { id: stepId, milestoneId } });
    if (!step) {
      res.status(404).json({ error: 'Step not found' });
      return null;
    }
    return step;
  }

  return {
    async list(req, res, next) {
      try {
        const milestoneId = toInteger(req.params.milestoneId);
        if (!milestoneId) {
          return res.status(400).json({ error: 'milestoneId is required' });
        }

        const steps = await MilestoneStep.findAll({
          where: { milestoneId },
          order: [['date', 'ASC'], ['created_at', 'ASC']]
        });
        const stepIds = steps.map((step) => getPlain(step).id);
        const blobs = stepIds.length ? await BlobModel.findAll({ where: { stepId: stepIds } }) : [];
        const blobsByStep = blobs.reduce((map, blob) => {
          const plain = getPlain(blob);
          const key = plain.stepId || plain.step_id;
          map[key] = map[key] || [];
          map[key].push(blob);
          return map;
        }, {});

        return res.json(steps.map((step) => serializeStep(step, blobsByStep[getPlain(step).id] || [])));
      } catch (error) {
        return next(error);
      }
    },

    async get(req, res, next) {
      try {
        const step = await findStep(req, res);
        if (!step) {
          return undefined;
        }
        const blobs = await BlobModel.findAll({ where: { stepId: getPlain(step).id } });
        return res.json(serializeStep(step, blobs));
      } catch (error) {
        return next(error);
      }
    },

    async create(req, res, next) {
      try {
        const milestoneId = toInteger(req.params.milestoneId);
        if (!milestoneId) {
          return res.status(400).json({ error: 'milestoneId is required' });
        }

        const validated = validateStepPayload(req.body, false);
        if (validated.error) {
          return res.status(400).json({ error: validated.error });
        }

        const step = await MilestoneStep.create({
          milestoneId,
          text: validated.value.text,
          date: validated.value.date
        });
        const blobs = await createAttachments(BlobModel, getPlain(step).id, normalizeFiles(req), maxAttachmentSizeBytes);
        return res.status(201).json(serializeStep(step, blobs));
      } catch (error) {
        return next(error);
      }
    },

    async update(req, res, next) {
      try {
        const step = await findStep(req, res);
        if (!step) {
          return undefined;
        }

        const validated = validateStepPayload(req.body, true);
        if (validated.error) {
          return res.status(400).json({ error: validated.error });
        }

        if (Object.keys(validated.value).length) {
          await step.update(validated.value);
        }

        const newBlobs = await createAttachments(BlobModel, getPlain(step).id, normalizeFiles(req), maxAttachmentSizeBytes);
        const existingBlobs = await BlobModel.findAll({ where: { stepId: getPlain(step).id } });
        return res.json(serializeStep(step, existingBlobs.concat(newBlobs)));
      } catch (error) {
        return next(error);
      }
    },

    async remove(req, res, next) {
      try {
        const step = await findStep(req, res);
        if (!step) {
          return undefined;
        }

        await BlobModel.destroy({ where: { stepId: getPlain(step).id } });
        await step.destroy();
        return res.status(204).send();
      } catch (error) {
        return next(error);
      }
    },

    async downloadAttachment(req, res, next) {
      try {
        const step = await findStep(req, res);
        if (!step) {
          return undefined;
        }

        const blobId = toInteger(req.params.blobId);
        if (!blobId) {
          return res.status(400).json({ error: 'blobId is required' });
        }

        const blob = await BlobModel.findOne({ where: { id: blobId, stepId: getPlain(step).id } });
        if (!blob) {
          return res.status(404).json({ error: 'Attachment not found' });
        }

        const plain = getPlain(blob);
        res.setHeader('Content-Type', plain.mimetype || 'application/octet-stream');
        res.setHeader('Content-Disposition', 'attachment; filename="' + encodeURIComponent(plain.filename || 'attachment') + '"');
        return res.send(plain.data);
      } catch (error) {
        return next(error);
      }
    }
  };
}

module.exports = createStepsController;
module.exports.createStepsController = createStepsController;
module.exports.DEFAULT_MAX_ATTACHMENT_SIZE_BYTES = DEFAULT_MAX_ATTACHMENT_SIZE_BYTES;
module.exports.createChecksum = createChecksum;
module.exports.validateStepPayload = validateStepPayload;
