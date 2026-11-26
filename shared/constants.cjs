'use strict';

/**
 * 记忆节点类型（对齐「记忆星云」的 episode/semantic 双层）。
 * 精简自 AgentGirl 的 src/shared/constants.js —— 本插件只需 MEM_KIND，
 * 挂件专用的 IPC/MODE/VOICE_MSG 等常量不随插件收编。
 */
const MEM_KIND = {
  EPISODE: 'episode',   // 原始对话片段
  FACT: 'fact',         // 抽取出的原子事实（偏好/身份/事件）
  PROFILE: 'profile',   // 长期画像（由 FACT 归纳）
  NOTE: 'note',         // 显式「记住这个」
};

module.exports = { MEM_KIND };
