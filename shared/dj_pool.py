"""Cache-independent DJ cohorts and measured one-song bridges."""

from shared.dj_engine import plan_transition

# Eight ordinary starts plus at most eight possible bridges. This bounds both
# speculative bandwidth and route work, independently of catalogue size.
ANALYSIS_COHORT_SIZE = 16
_BEATMATCH_TECHNIQUES = {"bass_swap", "filter_blend", "long_blend"}


def add_measured_bridges(previous, route, spares):
    """Improve unsafe seams only after the *entire* frozen cohort is measured.

    A cached spare must never compete against an unknown one. Partial coverage
    therefore inserts nothing; failed/disabled acquisition keeps the ordinary
    route playable. All original starts remain, with at most one extra per seam.
    No new recommendation roots are introduced.
    """
    if not previous.get("analysed") or any(
        not analysis.get("analysed")
        for analysis in [*(row["analysis"] for row in route), *(a for _, a in spares)]
    ):
        return route
    remaining = list(spares)
    result = []
    for row in route:
        target = row["analysis"]
        direct = plan_transition(previous, target, profile="adaptive")
        options = []
        if direct["technique"] not in _BEATMATCH_TECHNIQUES:
            for index, (item, analysis) in enumerate(remaining):
                before = plan_transition(previous, analysis, profile="adaptive")
                after = plan_transition(analysis, target, profile="adaptive")
                quality = min(before["score"], after["score"])
                if (before["technique"] in _BEATMATCH_TECHNIQUES
                        and after["technique"] in _BEATMATCH_TECHNIQUES and quality > direct["score"]):
                    options.append((quality, index, before, after))
        if options:
            # Stable ties follow the same seeded shuffle as the ordinary route.
            _, index, before, direct = max(options, key=lambda option: option[0])
            item, analysis = remaining.pop(index)
            result.append({**item, "route_kind": "bridge", "analysis": dict(analysis), "transition": before})
        result.append({**row, "transition": direct})
        previous = target
    return result
