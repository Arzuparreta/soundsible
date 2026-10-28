"""One related-music extraction per seed across DJ and Discover."""

from shared.work import Executor
from shared.database import instance_db

executor = Executor("related", 4)


def submit(video_id, fetch):
    import time
    import uuid
    from shared import work

    demand = work.current()
    temporary = demand is None
    if temporary:
        # Discover waits at most thirty seconds for asynchronous seed results.
        # A cache warmup cannot turn into an ownerless extraction afterward.
        demand = work.owner("related-" + uuid.uuid4().hex, 0)
        demand.expires = time.monotonic() + 30

    def measured():
        from shared.work import check

        cached = instance_db().get_related_mix(video_id)
        if cached is not None:
            return cached
        check()
        rows = fetch()
        check()
        instance_db().set_related_mix(video_id, rows)
        return rows

    future = executor.submit(video_id, measured, demand=demand)
    if temporary:
        future.add_done_callback(lambda _: demand.close())
    return future
