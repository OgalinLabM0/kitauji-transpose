import { useShallow } from 'zustand/react/shallow';
import { useEffect, useMemo, useState } from 'react';
import { useApp } from '../../store/app';
import { useFormDraft } from '../../store/useFormDraft';
import { DraftStatus } from '../../components/DraftStatus';
import { api } from '../../api';
import { Pill, Modal } from '../../components/ui';
import { Lock, Unlock, Edit2 } from 'lucide-react';
import type { AddressTrajectoryView } from '@shared/types';

interface TrajectoryGroup {
  speakerId: string;
  speakerName: string;
  targetId: string;
  targetName: string;
  trajectories: AddressTrajectoryView[];
}

export function AddressTrajectoryPage() {
  const seriesId = useApp(s => s.currentSeriesId);
  return <AddressTrajectoryContent key={seriesId ?? 'none'} />;
}
function AddressTrajectoryContent() {
  const { currentSeriesId, rev } = useApp(useShallow(s => ({ currentSeriesId: s.currentSeriesId, rev: s.rev })));
  const [addresses, setAddresses] = useState<AddressTrajectoryView[]>([]);
  const [filter, setFilter] = useState('');
  const [selectedPair, setSelectedPair] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);

  const [loadError, setLoadError] = useState('');
  useEffect(() => {
    let active = true;
    if (currentSeriesId) void api.knowledge.addresses(currentSeriesId).then(rows => {
      if (active) { setAddresses(rows); setLoadError(''); }
    }).catch(() => { if (active) setLoadError('称呼轨迹读取失败；请重新打开页面，未提交输入仍保留。'); });
    return () => { active = false; };
  }, [currentSeriesId, rev.knowledge]);

  // 按说话人-受话人分组
  const groups = useMemo(() => {
    const groupMap = new Map<string, TrajectoryGroup>();
    for (const addr of addresses) {
      const key = `${addr.speakerId}-${addr.targetId}`;
      if (!groupMap.has(key)) {
        groupMap.set(key, {
          speakerId: addr.speakerId,
          speakerName: addr.speakerName,
          targetId: addr.targetId,
          targetName: addr.targetName,
          trajectories: [],
        });
      }
      groupMap.get(key)!.trajectories.push(addr);
    }
    // 排序轨迹（按段落号）
    for (const group of groupMap.values()) {
      group.trajectories.sort((a, b) => a.validFromPara - b.validFromPara);
    }
    return Array.from(groupMap.values());
  }, [addresses]);

  // 搜索过滤
  const shown = useMemo(() => {
    if (!filter) return groups;
    const q = filter.toLowerCase();
    return groups.filter(g =>
      g.speakerName.toLowerCase().includes(q) ||
      g.targetName.toLowerCase().includes(q) ||
      g.trajectories.some(t => t.sourceFormJp.includes(q) || t.translatedForm.includes(q))
    );
  }, [groups, filter]);

  const selected = shown.find(g => `${g.speakerId}-${g.targetId}` === selectedPair);

  if (!currentSeriesId) return <div className="empty"><h2>请先选择系列</h2></div>;

  return (
    <>
      <div className="page-header">
        <h1>称呼轨迹</h1>
        <span className="sub small">{groups.length} 组关系 · {addresses.length} 条轨迹</span>
        <div className="grow" />
        <input className="input" style={{ width: 200 }} placeholder="搜索人物或称呼..." value={filter} onChange={e => setFilter(e.target.value)} />
      </div>
      <div className="three">
        {/* 左侧：关系对列表 */}
        <div className="col-left">
          {shown.length === 0 && <p className="faint small" style={{ padding: 12 }}>无匹配</p>}
          {shown.map(g => {
            const key = `${g.speakerId}-${g.targetId}`;
            const active = selectedPair === key;
            return (
              <button key={key} className={`list-item${active ? ' active' : ''}`} onClick={() => setSelectedPair(key)}>
                <div style={{ fontFamily: 'var(--font-reading)', fontSize: 'var(--text-sm)' }}>
                  {g.speakerName} → {g.targetName}
                </div>
                <span className="faint small" style={{ marginLeft: 'auto' }}>{g.trajectories.length}</span>
              </button>
            );
          })}
        </div>

        {/* 右侧：时间线 */}
        <div style={{ gridColumn: 'span 2' }}>
          {!selected && (
            <div className="empty"><p className="muted">选择一组关系查看称呼轨迹</p></div>
          )}
          {selected && (
            <div style={{ padding: 24 }}>
              <h2 style={{ fontFamily: 'var(--font-reading)', fontSize: 'var(--text-xl)', marginTop: 0, marginBottom: 16 }}>
                {selected.speakerName} → {selected.targetName}
              </h2>
              <div className="timeline">
                {selected.trajectories.map(t => (
                  <div key={t.id} className="timeline-item">
                    <div className="timeline-marker" />
                    <div className="timeline-content">
                      <div className="head">
                        <span className="range">
                          段落 {t.validFromPara}{t.validToPara ? ` ~ ${t.validToPara}` : ' ~ 至今'}
                        </span>
                        <Pill kind={t.confirmedByUser ? 'success' : 'muted'}>
                          {t.confirmedByUser ? '已确认' : '待确认'}
                        </Pill>
                        <Pill kind={t.allowVariation ? 'info' : 'warning'}>
                          {t.allowVariation ? (
                            <><Unlock size={12} /> 允许变化</>
                          ) : (
                            <><Lock size={12} /> 固定</>
                          )}
                        </Pill>
                      </div>
                      <div className="forms">
                        <span className="jp">{t.sourceFormJp}</span>
                        <span className="arrow">→</span>
                        <span className="zh">{t.translatedForm}</span>
                      </div>
                      {t.relationStage && (
                        <div className="meta">关系阶段：{t.relationStage}</div>
                      )}
                      <div className="actions">
                        <button
                          className="btn btn-text btn-sm"
                          onClick={() => setEditingId(t.id)}
                        >
                          <Edit2 size={12} /> 编辑
                        </button>
                        <button
                          className="btn btn-text btn-sm"
                          onClick={() => api.knowledge.setAddressVariation(t.id, !t.allowVariation)}
                        >
                          {t.allowVariation ? '改为固定' : '允许变化'}
                        </button>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
      {loadError && <p role="alert">{loadError}</p>}
      {editingId && addresses.some(a => a.id === editingId) && (
        <EditTrajectoryModal
          key={editingId}
          seriesId={currentSeriesId}
          trajectory={addresses.find(a => a.id === editingId)!}
          onClose={() => setEditingId(null)}
        />
      )}
    </>
  );
}

function EditTrajectoryModal({ trajectory, seriesId, onClose }: { trajectory: AddressTrajectoryView; seriesId: string; onClose: () => void }) {
  // Share the existing ending draft with the knowledge table for the same trajectory.
  const form = useFormDraft(`end-address-${trajectory.id}`, { at: '' }, { page: 'knowledge', seriesId, objectId: `end-address:${trajectory.id}`, title: `${trajectory.speakerName} → ${trajectory.targetName} · 结束称呼` }, trajectory);
  const endPara = form.value.at;
  const valid = !!endPara.trim() && Number.isSafeInteger(Number(endPara)) && Number(endPara) > trajectory.validFromPara;
  const close = () => { if (!form.busy) onClose(); };
  return (
    <Modal title="编辑称呼轨迹" onClose={close} footer={
      <>
        <button className="btn btn-secondary" disabled={form.busy} onClick={close}>关闭并保留输入</button>
        <button
          className="btn btn-primary"
          disabled={form.busy || form.conflict || form.malformed || !valid}
          onClick={async () => {
            if (valid && await form.save(() => api.knowledge.endAddress(trajectory.id, Number(endPara)), '已结束此称呼')) onClose();
          }}
        >
          保存
        </button>
      </>
    }>
      <DraftStatus draft={form} />
      <div className="field">
        <label>说话人 → 受话人</label>
        <div style={{ fontFamily: 'var(--font-reading)' }}>
          {trajectory.speakerName} → {trajectory.targetName}
        </div>
      </div>
      <div className="field">
        <label>称呼形式</label>
        <div style={{ fontFamily: 'var(--font-reading)' }}>
          {trajectory.sourceFormJp} → {trajectory.translatedForm}
        </div>
      </div>
      <div className="field">
        <label>有效段落范围</label>
        <div className="small muted">
          当前：段落 {trajectory.validFromPara} ~ {trajectory.validToPara ?? '至今'}
        </div>
      </div>
      <div className="field">
        <label>结束段落</label>
        <input
          className="input"
          type="number"
          placeholder="输入段落号以结束此轨迹"
          value={endPara}
          disabled={form.busy}
          min={trajectory.validFromPara + 1}
          step={1}
          onChange={e => form.change({ at: e.target.value })}
          autoFocus
        />
        <span className="hint">将此称呼轨迹标记为在指定段落后失效</span>
      </div>
    </Modal>
  );
}
