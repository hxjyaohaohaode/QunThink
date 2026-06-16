/**
 * 将旧模型名称映射为新的显示名称。
 * 用于兼容数据库中可能存在的旧群组名称（如 "与 deepseek-chat 的私聊"）。
 */
const OLD_TO_NEW_MAP: Record<string, string> = {
    'deepseek-chat': 'deepseek-v4-flash',
    'DeepSeek V3': 'deepseek-v4-flash',
    'deepseek-chat-v4': 'deepseek-v4-flash',
    'deepseek-reasoner': 'deepseek-v4-pro',
    'DeepSeek R1': 'deepseek-v4-pro',
    'deepseek-reasoner-v4': 'deepseek-v4-pro',
    'MiMo-V2.5': 'mimo-v2.5-pro',
    'mimo-v2.5': 'mimo-v2.5-pro',
    'mimo-v2-flash': 'mimo-v2.5-pro',
    'mimo-v2-omni': 'mimo-v2.5',
    'mimo-v2-tts': 'mimo-v2.5-tts-voicedesign',
    'deepseek_chat': 'deepseek-v4-flash',
    'glm-4-flash': 'GLM-4.7-Flash',
    'glm-4-flashx': 'GLM-4.7-FlashX',
    'glm-4-air': 'GLM-4.5-Air',
    'qwen3.5-flash': 'Qwen3.5-Flash',
    'qwen-turbo': 'qwen-turbo',
};

export function getDisplayAIName(internalName: string): string {
    return OLD_TO_NEW_MAP[internalName] || internalName;
}

/**
 * 将包含旧模型名称的文本替换为新模型名称。
 * 适用于群组名称等已经从数据库返回的文本。
 */
export function replaceOldModelNames(text: string): string {
    let result = text;
    for (const [oldName, newName] of Object.entries(OLD_TO_NEW_MAP)) {
        if (text.includes(oldName)) {
            result = result.split(oldName).join(newName);
        }
    }
    return result;
}