import tempfile
from collections.abc import Iterable, Mapping
from datetime import datetime, timezone, tzinfo
from pathlib import Path
from typing import TypeVar

import pandas as pd
import streamlit as st

from core import (
    Chat,
    Follow,
    MEASURES,
    by_author,
    by_hour,
    by_weekday,
    composition,
    cumulative,
    daily,
    extract_export,
    followers,
    following,
    follows_by_day,
    labels,
    load,
    profile_url,
    reaction_emojis,
    reciprocity,
    total,
)


@st.cache_data
def export_root(payloads: tuple[bytes, ...]) -> str:
    root = extract_export(payloads, Path(tempfile.mkdtemp()))
    return str(root) if root else ""


@st.cache_data
def load_chats(export: str) -> list[Chat]:
    return load(Path(export))


@st.cache_data
def load_follows(export: str) -> tuple[list[Follow], list[Follow]]:
    base = Path(export)
    return followers(base), following(base)


def ranked_bar(title: str, data: Mapping[str, int]) -> None:
    if data:
        st.subheader(title)
        st.bar_chart(pd.Series(data).sort_values(ascending=False))


K = TypeVar("K")


def ordered_bar(title: str, data: Mapping[K, int]) -> None:
    st.subheader(title)
    st.bar_chart(pd.Series(data))


def render_messages(chats: list[Chat], tz: tzinfo) -> None:
    name = st.sidebar.selectbox("Measure", list(MEASURES))
    measure = MEASURES[name]
    unit = name.title()

    ordered = sorted(chats, key=lambda c: len(c.messages), reverse=True)
    chosen = dict(zip(labels(ordered), ordered))
    who = st.sidebar.selectbox("Person", ["Everyone", *chosen])

    if who == "Everyone":
        messages = [m for c in chosen.values() for m in c.messages]
        ranked_bar(
            f"{unit} per person",
            {label: total(c.messages, measure) for label, c in chosen.items()},
        )
    else:
        chat = chosen[who]
        messages = list(chat.messages)
        split = by_author(messages, measure)
        you, them = st.columns(2)
        you.metric("You", split.get("self", 0))
        them.metric(chat.person, split.get("other", 0))

    ordered_bar(f"{unit} by hour of day", by_hour(messages, measure, tz))
    ordered_bar(f"{unit} by day of week", by_weekday(messages, measure, tz))

    if who != "Everyone":
        st.subheader(f"{unit} over time")
        view = st.radio(
            "View",
            ["Daily", "Cumulative"],
            horizontal=True,
            label_visibility="collapsed",
        )
        series = daily(messages, measure, tz)
        if view == "Cumulative":
            series = cumulative(series)
        st.line_chart(pd.Series(series))

    ranked_bar("Message composition", composition(messages))
    ranked_bar("Top reactions", reaction_emojis(messages))


def follow_table(group: Iterable[Follow]) -> pd.DataFrame:
    return pd.DataFrame(
        {"username": f.username, "profile": profile_url(f), "since": f.at.date()}
        for f in group
    )


def render_follows(
    follower_list: list[Follow], following_list: list[Follow], tz: tzinfo
) -> None:
    growth = pd.DataFrame({
        "followers": pd.Series(follows_by_day(follower_list, tz)),
        "following": pd.Series(follows_by_day(following_list, tz)),
    }).fillna(0).sort_index().cumsum()
    st.subheader("Follow growth")
    st.line_chart(growth)

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

    if st.sidebar.radio("View", ["Messages", "Follows"]) == "Messages":
        render_messages(load_chats(export), tz)
    else:
        render_follows(*load_follows(export), tz)


if __name__ == "__main__":
    main()
