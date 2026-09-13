import type { VolumeOverview } from '@shared/ipc';

export function deliveryStatus(value: VolumeOverview | null, running: boolean, error: string): { kind: 'muted' | 'info' | 'warning' | 'success'; label: string } {
  if (running) return { kind: 'info', label: '进行中' };
  if (error) return { kind: 'warning', label: '状态读取失败' };
  if (!value) return { kind: 'muted', label: '正在核对' };
  if (!value.total) return { kind: 'muted', label: '无内容' };
  if (value.report.ok) return { kind: 'success', label: '可保存' };
  if (!value.drafted) return { kind: 'muted', label: '未开始' };
  return { kind: 'warning', label: value.drafted < value.total ? '尚未完成' : '需要处理' };
}
