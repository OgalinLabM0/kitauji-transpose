/** 基础接口配置：统一Flash；正文与关键审校的思考由translationThinking按阶段处理。 */
export const TRANSLATION_PROFILE = {
  model: 'deepseek-flash',
  judgeModel: '',
  thinkingMode: 'disabled',
  usePreprocessingModel: false,
  preprocessingModel: 'deepseek-flash',
  preprocessingThinkingMode: 'disabled',
} as const;
