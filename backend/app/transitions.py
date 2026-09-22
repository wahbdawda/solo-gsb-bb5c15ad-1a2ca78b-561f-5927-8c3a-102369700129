"""编码流转（code transition）统计的纯函数逻辑。

统计口径：
  1. 收集所选标注的全部起止边界，把被任意标注覆盖的文本范围切成原子
     区间（边界两两之间的最小区段）；没有任何编码覆盖的原子区间直接
     跳过——它不产生状态，也把前后两个状态区间隔开；
  2. 每个原子区间的状态 = 覆盖它的编码集合（同一编码的多条重叠标注在
     集合中只计一次）；首尾相接（中间没有被跳过的无编码字符）且状态
     相同的相邻原子区间合并为一个状态区间；
  3. 按文档顺序遍历状态区间，相邻两个状态区间构成一次有向转移
     「来源状态 → 目标状态」；中间距离 = 两区间之间的无编码字符数
     （首尾相接时为 0）；
  4. 相同来源、目标状态的转移聚合计数，并保留每次转移的来源/目标
     区间、中间缺口与整段跨度（来源起点 → 目标终点）原文，供前端
     展开查看上下文与切回正文闪烁定位。
"""

from __future__ import annotations

from typing import Iterable

CONTEXT_CHARS = 20


def build_state_intervals(
    codings: Iterable[dict], code_ids: list[int]
) -> list[dict]:
    """把所选标注的覆盖范围切成原子区间，跳过无编码区间并合并相邻同状态区间。

    返回按文档顺序排列的状态区间：
      {"start", "end", "state": frozenset[code_id]}
    """
    selected = set(code_ids)
    active = [
        c
        for c in codings
        if c["code_id"] in selected and c["end"] > c["start"]
    ]

    points: set[int] = set()
    for c in active:
        points.add(c["start"])
        points.add(c["end"])
    boundaries = sorted(points)

    atoms: list[tuple[int, int, frozenset[int]]] = []
    for s, e in zip(boundaries, boundaries[1:]):
        if e <= s:
            continue
        state = frozenset(
            c["code_id"] for c in active if c["start"] <= s and c["end"] >= e
        )
        if not state:
            # 无编码区间：跳过，并天然阻止其前后的同状态区间被合并
            continue
        atoms.append((s, e, state))

    merged: list[dict] = []
    for s, e, state in atoms:
        if merged and merged[-1]["state"] == state and merged[-1]["end"] == s:
            # 相邻（中间没有被跳过的无编码字符）且状态相同：并入同一段
            merged[-1]["end"] = e
        else:
            merged.append({"start": s, "end": e, "state": state})
    return merged


def _state_segment(seg: dict, content: str | None = None) -> dict:
    out = {
        "start": seg["start"],
        "end": seg["end"],
        "state": sorted(seg["state"]),
    }
    if content is not None:
        out["text"] = content[seg["start"] : seg["end"]]
    return out


def compute_transitions(
    content: str, codings: list[dict], code_ids: list[int]
) -> dict:
    """计算相邻状态区间之间的有向转移统计。

    返回：
      - state_intervals：合并后的全部状态区间（含状态与原文）；
      - coded_char_count：状态区间覆盖的字符总数（无编码区间不计）；
      - transition_event_count：转移实例总数（未聚合）；
      - transitions：按 (来源状态, 目标状态) 聚合后的转移列表，按次数
        降序、首次出现位置升序排列，每条保留全部实例。
    """
    states = build_state_intervals(codings, code_ids)

    groups: dict[tuple[frozenset[int], frozenset[int]], dict] = {}
    for src, dst in zip(states, states[1:]):
        gap_start, gap_end = src["end"], dst["start"]
        span_start, span_end = src["start"], dst["end"]
        instance = {
            "source": _state_segment(src, content),
            "target": _state_segment(dst, content),
            "gap": {
                "start": gap_start,
                "end": gap_end,
                "length": gap_end - gap_start,
                "text": content[gap_start:gap_end],
            },
            # 整段跨度：来源起点 → 目标终点，供前端一次闪烁定位
            "span": {
                "start": span_start,
                "end": span_end,
                "length": span_end - span_start,
                "text": content[span_start:span_end],
            },
            "context_before": content[
                max(0, span_start - CONTEXT_CHARS) : span_start
            ],
            "context_after": content[span_end : span_end + CONTEXT_CHARS],
        }
        key = (src["state"], dst["state"])
        group = groups.get(key)
        if group is None:
            group = {
                "source_state": sorted(src["state"]),
                "target_state": sorted(dst["state"]),
                "count": 0,
                "min_distance": None,
                "max_distance": None,
                "first_start": span_start,
                "instances": [],
            }
            groups[key] = group
        distance = instance["gap"]["length"]
        group["count"] += 1
        group["min_distance"] = (
            distance if group["min_distance"] is None else min(group["min_distance"], distance)
        )
        group["max_distance"] = (
            distance if group["max_distance"] is None else max(group["max_distance"], distance)
        )
        group["instances"].append(instance)

    transitions = sorted(
        groups.values(),
        key=lambda g: (
            -g["count"],
            g["first_start"],
            g["source_state"],
            g["target_state"],
        ),
    )
    for g in transitions:
        del g["first_start"]

    return {
        "state_intervals": [
            {
                **_state_segment(seg, content),
                "length": seg["end"] - seg["start"],
            }
            for seg in states
        ],
        "coded_char_count": sum(seg["end"] - seg["start"] for seg in states),
        "transition_event_count": sum(g["count"] for g in transitions),
        "transitions": transitions,
    }
