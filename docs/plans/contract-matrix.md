# 接口契约矩阵

> 当前矩阵聚焦主链路高频接口，作为 `shared/contracts.ts`、`openapi/openapi.yaml`、`frontend/src/services/api.ts` 与 `backend/src/routes/*.js` 的统一对照表。

| 域 | 前端方法 | Method | 路径 | 请求体/参数 | 当前返回 |
| --- | --- | --- | --- | --- | --- |
| 认证 | `api.register` | `POST` | `/api/auth/register` | `RegisterInput` | `AuthResponse` |
| 认证 | `api.login` | `POST` | `/api/auth/login` | `LoginInput` | `AuthResponse` |
| 认证 | `api.getCurrentUser` | `GET` | `/api/auth/me` | 无 | `{ user }` |
| 群组 | `api.getGroups` | `GET` | `/api/groups` | `limit`/`offset` 可选 | `Group[]` |
| 群组 | `api.createGroup` | `POST` | `/api/groups` | `GroupCreateInput` | `Group` |
| 群组 | `api.getGroup` | `GET` | `/api/groups/:id` | `id` | `Group` |
| 消息 | `api.getMessages` | `GET` | `/api/groups/:groupId/messages` | `limit`/`before`/`after` | `PaginatedMessagesResponse` |
| 消息 | `api.sendMessage` | `POST` | `/api/groups/:groupId/messages` | `MessageCreateInput` | `Message` |
| 互动 | `api.likeMessage` | `POST` | `/api/messages/:id/like` | `id` | `{ likes, liked_by, likes_count }` |
| 互动 | `api.unlikeMessage` | `DELETE` | `/api/messages/:id/like` | `id` | `{ likes, liked_by, likes_count }` |
| 互动 | `api.dislikeMessage` | `POST` | `/api/messages/:id/dislike` | `id` | `{ disliked_by, dislikes }` |
| 互动 | `api.undislikeMessage` | `DELETE` | `/api/messages/:id/dislike` | `id` | `{ disliked_by, dislikes }` |
| 评论 | `api.addComment` | `POST` | `/api/comments` | `CommentCreateInput` | `Comment` |
| 文件 | `api.uploadFile` | `POST` | `/api/files/upload` | `multipart/form-data` | `FileUploadResponse` |
| 文件 | `api.getFileContent` | `GET` | `/api/files/:id/content` | `id` | `{ content }` |
| 文件 | `api.analyzeFile` | `POST` | `/api/files/:id/analyze` | `id` | 文件分析结果 |
| 文件 | `api.getGroupFiles` | `GET` | `/api/groups/:id/files` | `id` | `{ files: GroupFile[] }` |

## 已收敛规则

- 群创建只接受 `ai_members`，不再接受 `aiMembers` 别名。
- 消息点赞唯一事实源为数组状态，前端不再提交伪造 `user_id`。
- 文件上传不再信任客户端 `uploader_id`，真实归属只来自 `req.userId`。
- 群文件列表只读 `db.data.files` 单一数据源。

## 校验入口

- 共享类型：`shared/contracts.ts`
- OpenAPI：`openapi/openapi.yaml`
- CI 校验：`scripts/validate-openapi.mjs`
