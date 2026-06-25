import tempfile
from collections import Counter
from collections.abc import Iterable, Mapping, Sequence
from datetime import date, datetime, timezone, tzinfo
from hashlib import sha256
from pathlib import Path
from typing import TypeVar

import pandas as pd
import plotly.express as px
import streamlit as st
from plotly.graph_objects import Figure

from core import (
    Chat,
    Follow,
    MEASURES,
    Measure,
    Message,
    by_author,
    by_hour,
    by_weekday,
    cumulative,
    daily,
    extract_export,
    followers,
    following,
    labels,
    load,
    profile_url,
    reactions_by_actor,
    reciprocity,
    total,
)

TOP_N = 25
ACTOR_LABEL = {"self": "You", "other": "Them"}

# Catppuccin Mocha
ACCENT = "#cba6f7"  # mauve
SECONDARY = "#fab387"  # peach
FOREGROUND = "#cdd6f4"
GRID = "#313244"

px.defaults.template = "plotly_dark"

K = TypeVar("K")


def show(fig: Figure) -> None:
    fig.update_layout(
        margin=dict(t=10, b=10, l=10, r=10),
        paper_bgcolor="rgba(0,0,0,0)",
        plot_bgcolor="rgba(0,0,0,0)",
        font_color=FOREGROUND,
    )
    fig.update_xaxes(gridcolor=GRID, zerolinecolor=GRID)
    fig.update_yaxes(rangemode="tozero", gridcolor=GRID, zerolinecolor=GRID)
    st.plotly_chart(fig, use_container_width=True)


@st.cache_data
def export_root(payloads: tuple[bytes, ...]) -> str:
    key = sha256(b"".join(payloads)).hexdigest()
    dest = Path(tempfile.gettempdir()) / "instagram-export" / key
    root = extract_export(payloads, dest)
    return str(root) if root else ""


@st.cache_data
def load_chats(export: str) -> list[Chat]:
    return load(Path(export))


@st.cache_data
def load_follows(export: str) -> tuple[list[Follow], list[Follow]]:
    base = Path(export)
    return followers(base), following(base)


def bars(
    title: str,
    data: Mapping[K, int],
    *,
    value_title: str,
    category_title: str,
    sort: bool = False,
    cap: int | None = None,
    label_angle: int = 0,
) -> None:
    items = list(data.items())
    if sort:
        items.sort(key=lambda kv: kv[1], reverse=True)
    if cap is not None:
        items = items[:cap]
    if not items:
        return
    st.subheader(title)
    order = [str(k) for k, _ in items]
    frame = pd.DataFrame({"category": order, "value": [v for _, v in items]})
    fig = px.bar(
        frame,
        x="category",
        y="value",
        labels={"category": category_title, "value": value_title},
    )
    fig.update_xaxes(
        categoryorder="array", categoryarray=order, tickangle=label_angle
    )
    fig.update_traces(marker_color=ACCENT)
    show(fig)


def timeline(series: Mapping[date, int], *, value_title: str) -> None:
    frame = pd.DataFrame(
        {"date": list(series), "value": list(series.values())}
    )
    fig = px.line(
        frame,
        x="date",
        y="value",
        labels={"date": "Date", "value": value_title},
    )
    fig.update_traces(line_color=ACCENT)
    fig.update_xaxes(title_text="")
    show(fig)


def reactions_chart(messages: Iterable[Message]) -> None:
    data = reactions_by_actor(messages)
    if not data:
        return
    st.subheader("Top reactions")
    totals: Counter[str] = Counter()
    for (emoji, _), n in data.items():
        totals[emoji] += n
    top = [emoji for emoji, _ in totals.most_common(TOP_N)]
    frame = pd.DataFrame(
        {"emoji": emoji, "who": ACTOR_LABEL[actor], "value": n}
        for (emoji, actor), n in data.items()
        if emoji in top
    )
    fig = px.bar(
        frame,
        x="emoji",
        y="value",
        color="who",
        barmode="group",
        labels={"emoji": "Reaction", "value": "Reactions", "who": "By"},
        color_discrete_map={"You": ACCENT, "Them": SECONDARY},
    )
    fig.update_xaxes(categoryorder="array", categoryarray=top, tickangle=0)
    fig.update_xaxes(title_text="")
    fig.update_layout(legend_title_text="")
    show(fig)


def message_breakdown(
    messages: Sequence[Message], measure: Measure, unit: str, tz: tzinfo
) -> None:
    bars(
        f"{unit} by hour of day",
        by_hour(messages, measure, tz),
        value_title=unit,
        category_title="Hour",
    )
    bars(
        f"{unit} by day of week",
        by_weekday(messages, measure, tz),
        value_title=unit,
        category_title="Day",
    )


def render_overview(
    chosen: dict[str, Chat], measure: Measure, unit: str, tz: tzinfo
) -> None:
    messages = [m for c in chosen.values() for m in c.messages]
    bars(
        f"{unit} per person",
        {label: total(c.messages, measure) for label, c in chosen.items()},
        value_title=unit,
        category_title="Person",
        sort=True,
        cap=TOP_N,
        label_angle=-45,
    )
    message_breakdown(messages, measure, unit, tz)
    reactions_chart(messages)


def render_conversation(
    chat: Chat, measure: Measure, unit: str, tz: tzinfo
) -> None:
    split = by_author(chat.messages, measure)
    you, them = st.columns(2)
    you.metric("You", split.get("self", 0))
    them.metric(chat.person, split.get("other", 0))

    message_breakdown(chat.messages, measure, unit, tz)

    trend = st.sidebar.radio("Over time", ["Daily", "Cumulative"])
    st.subheader(f"{unit} over time")
    series = daily(chat.messages, measure, tz)
    if trend == "Cumulative":
        series = cumulative(series)
    timeline(series, value_title=unit)

    reactions_chart(chat.messages)


def render_messages(chats: list[Chat], tz: tzinfo) -> None:
    ordered = sorted(chats, key=lambda c: len(c.messages), reverse=True)
    chosen = dict(zip(labels(ordered), ordered))

    who = st.sidebar.selectbox("Person", ["Everyone", *chosen])
    name = st.sidebar.selectbox("Measure", list(MEASURES))
    measure = MEASURES[name]
    unit = name.title()

    if who == "Everyone":
        render_overview(chosen, measure, unit, tz)
    else:
        render_conversation(chosen[who], measure, unit, tz)


def follow_table(group: Iterable[Follow]) -> pd.DataFrame:
    return pd.DataFrame(
        {
            "username": f.username,
            "profile": profile_url(f),
            "since": f.at.date(),
        }
        for f in group
    )


def render_follows(
    follower_list: list[Follow], following_list: list[Follow]
) -> None:
    rec = reciprocity(follower_list, following_list)
    groups = {
        "Mutual": rec.mutual,
        "You follow, no follow-back": rec.you_follow_only,
        "Follows you, not followed back": rec.follows_you_only,
    }
    pick = st.sidebar.radio("Group", list(groups))
    group = groups[pick]
    st.subheader(f"{pick} ({len(group)})")
    st.dataframe(
        follow_table(group),
        hide_index=True,
        column_config={"profile": st.column_config.LinkColumn()},
    )


def main() -> None:
    st.set_page_config(page_title="Instagram", layout="wide")
    st.title("Instagram")
    tz = datetime.now().astimezone().tzinfo or timezone.utc

    uploads = st.sidebar.file_uploader(
        "Instagram export (.zip)",
        type="zip",
        accept_multiple_files=True,
    )
    payloads = tuple(f.getvalue() for f in uploads)
    export = export_root(payloads) if payloads else ""

    if not export:
        st.info(
            "Upload your Instagram export as a .zip. "
            "If you've unzipped it, re-compress the export folder. "
            "Split exports can be uploaded together."
        )
        st.stop()

    st.sidebar.divider()
    view = st.sidebar.radio("View", ["Messages", "Follows"])
    st.sidebar.divider()

    if view == "Messages":
        render_messages(load_chats(export), tz)
    else:
        render_follows(*load_follows(export))


if __name__ == "__main__":
    main()
