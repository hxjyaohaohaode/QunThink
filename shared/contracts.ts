export type GroupType = 'preset' | 'custom' | 'private' | 'ai_private';
export type SenderType = 'user' | 'ai' | 'system';
export type MessageContentType = 'text' | 'code' | 'file' | 'system';

export interface ApiErrorEnvelope {
  error: string;
}

export interface ApiSuccessEnvelope {
  success: true;
}

export interface ApiListEnvelope<T> {
  items: T[];
}

export interface AuthUser {
  id: string;
  username: string;
  nickname?: string;
}

export interface AuthSessionStatus {
  enabled: boolean;
  valid?: boolean;
  mode?: 'session' | 'token';
  message?: string;
}

export interface AuthResponse extends ApiSuccessEnvelope {
  user: AuthUser;
}

export interface GroupFile {
  id: string;
  group_id: string;
  name: string;
  url: string;
  size: number;
  type: string;
  uploaded_at: string;
}

export interface Group {
  id: string;
  name: string;
  description: string;
  type: GroupType;
  is_private?: boolean;
  is_ai_private?: boolean;
  pinned?: boolean;
  avatar_url?: string | null;
  avatar_color?: string | null;
  background_url?: string | null;
  announcement?: string;
  notifications_enabled?: boolean;
  debate_mode: boolean;
  debate_level: number;
  debate_config?: {
    mode?: string;
    topic?: string;
    roles?: {
      proponents?: string[];
      opponents?: string[];
      judge?: string[];
      audience?: string[];
    };
    memory_enabled?: boolean;
    time_limit?: number;
    max_turns?: number;
  };
  ai_members: string[];
  created_at: string;
  last_message_at?: string;
  last_message_preview?: string | null;
  topic?: string;
  is_active?: boolean;
  files?: GroupFile[];
}

export interface Comment {
  id: string;
  message_id: string;
  parent_id?: string;
  reply_to?: string | string[];
  sender_type: SenderType;
  sender_id?: string;
  content: string;
  created_at: string;
  depth?: number;
  likes?: number;
  liked_by?: string[];
  replies?: Comment[];
}

export interface MessageAttachment {
  id: string;
  name: string;
  type: string;
  size: number;
  url?: string;
  media_description?: string;
}

export interface MessageTTSAudio {
  id: string;
  audioUrl: string;
  duration: number;
  voiceId: string;
  toneId: string;
  createdAt: string;
  transcript?: string;
  format?: string;
  provider?: string;
}

export interface Message {
  id: string;
  group_id: string;
  sender_type: SenderType;
  sender_id?: string;
  content: string;
  content_type: MessageContentType;
  reply_to?: string | string[];
  reply_to_ids?: string[];
  reply_to_message?: Message;
  reply_to_messages?: Message[];
  attachments?: MessageAttachment[];
  metadata?: Record<string, unknown>;
  liked_by?: string[];
  likes?: string[];
  likes_count?: number;
  disliked_by?: string[];
  dislikes?: number;
  comments?: Comment[];
  created_at: string;
  is_edited?: boolean;
  edited_at?: string;
  status?: 'sending' | 'sent' | 'failed';
  tempId?: string;
  audio_urls?: string[];
  is_streaming?: boolean;
  ttsAudio?: MessageTTSAudio;
}

export interface PaginatedMessagesResponse {
  messages: Message[];
  hasMore: boolean;
}

export interface GroupCreateInput {
  name: string;
  description?: string;
  ai_members?: string[];
  is_private?: boolean;
  ai_member?: string;
  avatar_url?: string;
  avatar_color?: string | null;
}

export interface GroupSettingsInput {
  name?: string;
  description?: string;
  avatar_url?: string | null;
  avatar_color?: string | null;
  background_url?: string;
  announcement?: string;
  notifications_enabled?: boolean;
}

export interface MessageCreateInput {
  content: string;
  content_type?: MessageContentType;
  reply_to?: string | string[];
  metadata?: Record<string, unknown>;
  attachments?: MessageAttachment[];
}

export interface CommentCreateInput {
  message_id: string;
  content: string;
  parent_id?: string | null;
  reply_to?: string | null;
}

export interface LoginInput {
  username: string;
  password: string;
}

export interface RegisterInput extends LoginInput {
  nickname?: string;
}

export interface ChangePasswordInput {
  currentPassword: string;
  newPassword: string;
}

export interface UploadedFile {
  id: string;
  group_id: string;
  uploader_id: string;
  owner_user_id: string;
  filename: string;
  stored_filename?: string;
  original_path: string;
  parsed_content?: string | null;
  media_description?: string;
  mime_type: string;
  file_size: number;
  created_at: string;
  url?: string;
  original_name?: string;
}

export interface FileUploadResponse extends ApiSuccessEnvelope {
  file: UploadedFile;
}
