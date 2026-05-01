import { z } from 'zod';

const validateBody = (schema) => (req, res, next) => {
  try {
    req.body = schema.parse(req.body);
    next();
  } catch (error) {
    if (error instanceof z.ZodError) {
      const errors = error.issues.map(e => `${e.path.join('.')}: ${e.message}`).join('; ');
      return res.status(400).json({ error: errors });
    }
    next(error);
  }
};

const validateQuery = (schema) => (req, res, next) => {
  try {
    req.query = schema.parse(req.query);
    next();
  } catch (error) {
    if (error instanceof z.ZodError) {
      const errors = error.issues.map(e => `${e.path.join('.')}: ${e.message}`).join('; ');
      return res.status(400).json({ error: errors });
    }
    next(error);
  }
};

const groupCreateInputShape = {
  name: z.string().min(1).max(100),
  description: z.string().max(500).optional(),
  ai_members: z.array(z.string()).optional(),
  is_private: z.boolean().optional(),
  ai_member: z.string().optional(),
  avatar_url: z.string().min(1).optional(),
  avatar_color: z.string().max(32).nullable().optional()
};

const createGroupSchema = z.object({
  ...groupCreateInputShape
}).strict();

const updateDebateSchema = z.object({
  debate_mode: z.boolean(),
  debate_level: z.number().int().min(0).max(3).optional()
});

const pinGroupSchema = z.object({
  pinned: z.boolean()
});

const sendMessageSchema = z.object({
  content: z.string().min(1).max(10000),
  content_type: z.enum(['text', 'code', 'file', 'system']).optional(),
  reply_to: z.string().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  attachments: z.array(z.object({
    id: z.string(),
    name: z.string(),
    type: z.string(),
    size: z.number(),
    url: z.string().optional()
  })).max(10).optional()
});

const editMessageSchema = z.object({
  content: z.string().min(1).max(10000)
});

const batchDeleteSchema = z.object({
  message_ids: z.array(z.string()).min(1),
  group_id: z.string()
});

const commentSchema = z.object({
  message_id: z.string(),
  content: z.string().min(1).max(2000),
  parent_id: z.string().nullable().optional(),
  reply_to: z.string().nullable().optional()
});

const smartLikeSchema = z.object({
  message: z.object({}).passthrough(),
  contextMessages: z.array(z.object({}).passthrough()),
  senderInfo: z.object({}).passthrough()
});

const autoLikeSchema = z.object({
  messageId: z.string(),
  groupId: z.string()
});

const storeMemorySchema = z.object({
  content: z.string().min(1).max(5000),
  category: z.string().optional(),
  metadata: z.record(z.string(), z.unknown()).optional()
});

const retrieveMemorySchema = z.object({
  query: z.string().min(1),
  category: z.string().optional(),
  senderId: z.string().optional(),
  dateRange: z.object({
    start: z.string(),
    end: z.string()
  }).optional(),
  limit: z.number().int().min(1).max(100).optional()
});

const updatePersonaSchema = z.object({
  name: z.string().min(1).max(50).optional(),
  avatar: z.string().max(2048).nullable().optional(),
  avatar_url: z.string().max(2048).nullable().optional(),
  color: z.string().max(32).nullable().optional(),
  styleTag: z.string().max(100).optional(),
  style: z.string().max(5000).optional(),
  replyStyle: z.string().max(5000).optional(),
  personality: z.string().max(5000).optional(),
  typicalPhrases: z.array(z.string().max(200)).max(20).optional(),
  expertise: z.array(z.string().max(100)).max(20).optional(),
  speakingTraits: z.string().max(2000).optional(),
  keywords: z.array(z.string().max(50)).max(30).optional(),
  messageLength: z.enum(['short', 'medium', 'long']).optional(),
  responseConfig: z.object({
    enabled: z.boolean().optional(),
    responseFrequency: z.number().min(0).max(1).optional(),
    minDelay: z.number().int().min(0).max(60000).optional(),
    maxDelay: z.number().int().min(0).max(60000).optional(),
    maxResponsesPerConversation: z.number().int().min(1).max(100).optional(),
    cooldownBetweenResponses: z.number().int().min(0).max(60000).optional()
  }).optional(),
  socialConfig: z.object({
    maxMessageLength: z.number().int().min(50).max(4000).optional(),
    enableQuoting: z.boolean().optional(),
    enableSocialFeedback: z.boolean().optional(),
    quoteProbability: z.number().min(0).max(1).optional(),
    maxQuotesPerMessage: z.number().int().min(0).max(10).optional(),
    likeProbability: z.number().min(0).max(1).optional(),
    commentProbability: z.number().min(0).max(1).optional(),
    dislikeProbability: z.number().min(0).max(1).optional(),
    interactionProbability: z.number().min(0).max(1).optional()
  }).optional(),
  modelConfig: z.object({
    maxTokens: z.number().int().min(1).max(32000).optional(),
    temperature: z.number().min(0).max(2).optional(),
    topP: z.number().min(0).max(1).optional(),
    frequencyPenalty: z.number().min(0).max(2).optional(),
    presencePenalty: z.number().min(0).max(2).optional()
  }).optional(),
  debateConfig: z.object({
    debateStyle: z.enum(['formal', 'casual', 'aggressive', 'diplomatic']).optional(),
    preferredRole: z.string().max(50).optional()
  }).optional(),
  preferredRole: z.string().max(50).optional(),
  customRoleName: z.string().max(50).optional(),
  questionProbability: z.number().min(0).max(1).optional(),
  debateTendency: z.enum(['low', 'medium', 'high']).optional(),
  silenceProbability: z.number().min(0).max(1).optional(),
  speakingOrder: z.number().int().min(1).max(10).optional(),
  firstSpeakerTopics: z.array(z.string().max(100)).max(20).optional()
}).strict();

const updateProfileSchema = z.object({
  displayName: z.string().min(1).max(50).optional(),
  avatar: z.string().max(2048).nullable().optional(),
  settings: z.record(z.unknown()).optional()
});

const ttsSchema = z.object({
  text: z.string().min(1).max(5000),
  voice: z.string().max(50).optional(),
  speed: z.number().min(0.5).max(2).optional(),
  groupId: z.string().optional()
});

const smsSendSchema = z.object({
  phone: z.string().regex(/^1[3-9]\d{9}$/, '手机号格式不正确')
});

const smsVerifySchema = z.object({
  phone: z.string().regex(/^1[3-9]\d{9}$/, '手机号格式不正确'),
  code: z.string().regex(/^\d{4,8}$/, '验证码格式不正确')
});

export {
  validateBody,
  validateQuery,
  createGroupSchema,
  groupCreateInputShape,
  updateDebateSchema,
  pinGroupSchema,
  sendMessageSchema,
  editMessageSchema,
  batchDeleteSchema,
  commentSchema,
  smartLikeSchema,
  autoLikeSchema,
  storeMemorySchema,
  retrieveMemorySchema,
  updatePersonaSchema,
  updateProfileSchema,
  ttsSchema,
  smsSendSchema,
  smsVerifySchema
};
