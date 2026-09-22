import { useEffect, useMemo, useState } from 'react'

/** 列表摘录：压缩空白并截断，避免整段原文撑爆列表 */
function excerpt(text, max = 80) {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max)}…` : flat
}

/** 状态 = 覆盖同一区间的编码集合，以彩色圆点 + 名称列出 */
function StateChips({ ids, codes }) {
  return (
    <span className="flow-state">
      {ids.map((id) => {
        const code = codes.find((c) => c.id === id)
        return (
          <span key={id} className="flow-chip" title={code?.name ?? `#${id}`}>
            <span className="dot" style={{ background: code?.color ?? '#999' }} />
            {code?.name ?? `#${id}`}
          </span>
        )
      })}
    </span>
  )
}

const entryKey = (t) => `${t.source_state.join('.')}>${t.target_state.join('.')}`

/**
 * 编码流转视图：按文档顺序展示相邻编码状态区间之间的有向转移。
 *
 * 数据来自 GET /api/documents/{id}/transitions：后端把所选标注的全部起止
 * 边界切成原子区间，以覆盖编码集合表示状态，跳过无编码区间并合并相邻同
 * 状态区间，再统计相邻状态的有向转移次数；每次转移回传来源、目标区间、
 * 中间距离与整段跨度原文。
 *  - 顶部支持最小次数与最大间距（中间无编码字符数，0 = 不限）本地筛选；
 *  - 点击条目展开全部转移实例及原文上下文；
 *  - 点击实例经 onLocateInstance 切回正文，闪烁定位来源→目标的整段跨度；
 *  - 零标注、只有单一状态（无转移）或筛选无结果时给出明确空状态。
 */
export default function TransitionView({ stats, loading, error, onLocateInstance }) {
  const [minCount, setMinCount] = useState(1)
  const [maxGap, setMaxGap] = useState(0) // 0 = 不限制最大间距
  const [expanded, setExpanded] = useState(() => new Set())

  const codes = stats?.codes ?? []
  const allTransitions = stats?.transitions ?? []

  // 文档 / 筛选 / 标注变化后统计数据被替换：重置展开项与本地筛选
  useEffect(() => {
    setExpanded(new Set())
  }, [stats])

  // 最大间距先过滤实例，再用过滤后的实例数套最小次数
  const visibleTransitions = useMemo(() => {
    const result = []
    for (const t of allTransitions) {
      const instances =
        maxGap > 0 ? t.instances.filter((i) => i.gap.length <= maxGap) : t.instances
      if (t.count >= minCount && instances.length > 0) {
        result.push({ ...t, visible_instances: instances })
      }
    }
    return result
  }, [allTransitions, minCount, maxGap])

  const visibleEventCount = visibleTransitions.reduce(
    (n, t) => n + t.visible_instances.length,
    0
  )

  function toggle(key) {
    setExpanded((cur) => {
      const next = new Set(cur)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  const stateCount = stats?.state_intervals.length ?? 0
  const eventCount = stats?.transition_event_count ?? 0

  return (
    <div className="flow-panel">
      <div className="flow-toolbar">
        <label className="flow-filter-field">
          最小次数
          <input
            type="number"
            min="1"
            value={minCount}
            onChange={(e) => setMinCount(Math.max(1, Number(e.target.value) || 1))}
          />
          次
        </label>
        <label className="flow-filter-field">
          最大间距
          <input
            type="number"
            min="0"
            value={maxGap}
            onChange={(e) => setMaxGap(Math.max(0, Number(e.target.value) || 0))}
          />
          字（0 = 不限）
        </label>
      </div>

      {stats && (
        <p className="speaker-summary">
          全文 {stats.document_length} 字 · 状态区间 {stateCount} 段 · 转移事件{' '}
          {eventCount} 次 · 聚合为 {allTransitions.length} 种
          {(minCount > 1 || maxGap > 0) &&
            `（筛选后 ${visibleEventCount} 次 / ${visibleTransitions.length} 种）`}
        </p>
      )}

      {loading && <div className="cooc-status">流转统计加载中…</div>}
      {!loading && error && <div className="cooc-status error">{error}</div>}

      {!loading && !error && codes.length === 0 && (
        <div className="cooc-status">当前没有参与统计的编码，请在侧栏勾选编码。</div>
      )}
      {!loading && !error && codes.length > 0 && stateCount === 0 && (
        <div className="cooc-status">
          当前筛选的编码在本文档还没有任何标注：零标注时不存在状态区间与转移，添加标注后将自动刷新。
        </div>
      )}
      {!loading && !error && stateCount === 1 && (
        <div className="cooc-status">
          所选编码只形成了 1 个状态区间，文档中没有相邻状态之间的转移；
          尝试勾选更多编码或添加新的标注。
        </div>
      )}
      {!loading &&
        !error &&
        stateCount > 1 &&
        eventCount > 0 &&
        visibleTransitions.length === 0 && (
          <div className="cooc-status">
            当前筛选（最小次数 {minCount}
            {maxGap > 0 ? ` · 最大间距 ${maxGap} 字` : ''}
            ）下没有符合条件的转移，可放宽筛选条件后重试。
          </div>
        )}

      {!loading && !error && visibleTransitions.length > 0 && (
        <ul className="flow-list">
          {visibleTransitions.map((t) => {
            const key = entryKey(t)
            const isOpen = expanded.has(key)
            return (
              <li key={key}>
                <button
                  type="button"
                  className={`flow-entry${isOpen ? ' open' : ''}`}
                  onClick={() => toggle(key)}
                >
                  <span className="flow-states">
                    <StateChips ids={t.source_state} codes={codes} />
                    <span className="flow-arrow">→</span>
                    <StateChips ids={t.target_state} codes={codes} />
                  </span>
                  <span className="flow-count-badge">
                    {t.visible_instances.length}
                    {t.visible_instances.length < t.count && ` / ${t.count}`} 次
                  </span>
                  <span className="flow-dist">
                    间距{' '}
                    {t.min_distance === t.max_distance
                      ? `${t.min_distance}`
                      : `${t.min_distance}–${t.max_distance}`}{' '}
                    字
                  </span>
                  <span className="flow-toggle">{isOpen ? '收起 ▲' : '展开 ▼'}</span>
                </button>
                {isOpen && (
                  <ul className="cooc-segment-list flow-instance-list">
                    {t.visible_instances.map((inst, i) => (
                      <li
                        key={`${inst.span.start}-${inst.span.end}-${i}`}
                      >
                        <button
                          type="button"
                          className="cooc-segment flow-instance"
                          title="点击切回正文并闪烁定位整段跨度"
                          onClick={() => onLocateInstance(inst)}
                        >
                          <span className="flow-inst-head">
                            <code>
                              [{inst.source.start}, {inst.source.end}) → [
                              {inst.target.start}, {inst.target.end})
                            </code>
                            <em>
                              间距 {inst.gap.length} 字 · 跨度 {inst.span.length}{' '}
                              字 · 点击定位整段
                            </em>
                          </span>
                          <span className="flow-quote">
                            {inst.context_before && (
                              <span className="flow-ctx">
                                {excerpt(inst.context_before, 20)}
                              </span>
                            )}
                            <span className="flow-src">
                              「{excerpt(inst.source.text)}」
                            </span>
                            {inst.gap.length > 0 && (
                              <span className="flow-ctx">
                                ⟨{excerpt(inst.gap.text)}⟩
                              </span>
                            )}
                            <span className="flow-tgt">
                              「{excerpt(inst.target.text)}」
                            </span>
                            {inst.context_after && (
                              <span className="flow-ctx">
                                {excerpt(inst.context_after, 20)}
                              </span>
                            )}
                          </span>
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            )
          })}
        </ul>
      )}

      <p className="hint">
        口径：把所选标注的全部起止边界切成原子区间，以覆盖编码集合表示状态；跳过无编码区间并合并
        相邻同状态区间，再按文档顺序统计相邻状态的有向转移；间距为两区间之间的无编码字符数
        （首尾相接为 0）。编码筛选或标注变化后结果自动刷新。
      </p>
    </div>
  )
}
