export const attachmentBackendMessages: Record<string, string> = {
  '附件无效或超过 10 MiB': 'The attachment is invalid or exceeds 10 MiB',
  '附件编码无效': 'Invalid attachment encoding',
  '单个附件不能超过 10 MiB': 'Each attachment must be at most 10 MiB',
  '每条消息最多添加 10 个不同附件': 'Each message can contain at most 10 different attachments',
  '每条消息的附件合计不能超过 20 MiB': 'Attachments in one message must total at most 20 MiB',
  '附件已丢失或不可读取：{name}': 'The attachment is missing or unreadable: {name}',
  '附件不存在': 'Attachment not found',
  '附件参数无效': 'Invalid attachment parameters',
  '请输入消息或添加附件': 'Enter a message or add an attachment',
  '分叉历史与本条消息的图片合计超出附件限制，请减少图片或从更早的消息分叉后重试': 'Images in the fork history and current message exceed the attachment limit. Reduce the images or fork from an earlier message and try again',
  '{label} 未声明支持图片输入，请更新 CLI 或移除图片后重试': '{label} does not advertise image input support. Update the CLI or remove the images and try again'
}
