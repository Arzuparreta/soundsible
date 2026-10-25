"""Cache-independent DJ cohorts and measured one-song bridges."""

from shared.dj.transitions import plan_transition
from shared.dj.timing import BEATMATCH_TECHNIQUES, rate_fits

# Eight ordinary starts plus at most eight possible bridges. This bounds both
# speculative bandwidth and route work, independently of catalogue size.
ANALYSIS_COHORT_SIZE = 16
def _beatmatched(plan, outgoing, incoming):
    if not all(float(analysis.get("bpm") or 0) > 0 for analysis in (outgoing, incoming)):
        return False
    if plan.get("technique") not in BEATMATCH_TECHNIQUES:
        return False
    # Admission still validates the executed plan, independently of its score.
    return rate_fits(plan, tolerance=None)


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
        direct = plan_transition(previous, target)
        options = []
        if not _beatmatched(direct, previous, target):
            for index, (item, analysis) in enumerate(remaining):
                before = plan_transition(previous, analysis)
                after = plan_transition(analysis, target)
                quality = min(before["score"], after["score"])
                if (_beatmatched(before, previous, analysis) and _beatmatched(after, analysis, target)
                        and quality > direct["score"]):
                    options.append((quality, index, before, after))
        if options:
            # Stable ties follow the same seeded shuffle as the ordinary route.
            _, index, before, direct = max(options, key=lambda option: option[0])
            item, analysis = remaining.pop(index)
            result.append({**item, "route_kind": "bridge", "analysis": dict(analysis), "transition": before})
        result.append({**row, "transition": direct})
        previous = target
    return result
