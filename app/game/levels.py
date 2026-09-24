"""Level curve and titles.

A decelerating curve: early levels arrive quickly, later ones stretch. Titles
describe *training maturity* - how long and how steadily someone has shown up -
and never strength or body weight, so a consistent beginner outranks a strong
lifter who trains when they feel like it.
"""


def xp_for_level(n: int) -> int:
    """XP needed to go from level n to n+1."""
    return round(80 * n**1.6)


def level_for_xp(total: int) -> int:
    level, acc = 1, 0
    while True:
        acc += xp_for_level(level)
        if total < acc:
            return level
        level += 1


def xp_to_reach(level: int) -> int:
    return sum(xp_for_level(n) for n in range(1, level))


TITLES: tuple[tuple[int, str], ...] = (
    (50, "Veteran"),
    (35, "Seasoned"),
    (20, "Committed"),
    (10, "Consistent"),
    (5, "Regular"),
    (1, "Novice"),
)


def title_for_level(level: int) -> str:
    for minimum, title in TITLES:
        if level >= minimum:
            return title
    return "Novice"


def level_progress(total: int) -> dict:
    level = level_for_xp(total)
    base = xp_to_reach(level)
    span = xp_for_level(level)
    into = total - base
    return {
        "level": level,
        "title": title_for_level(level),
        "total_xp": total,
        "into_level": into,
        "level_span": span,
        "to_next": max(0, span - into),
    }
