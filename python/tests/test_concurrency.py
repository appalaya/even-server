"""Atomic sequencing under concurrent writes, against a real server: TestClient
runs one request at a time, so this uses uvicorn on a random port."""

import threading
from concurrent.futures import ThreadPoolExecutor

import httpx

from support import batch, envelope, new_group

THREADS = 8
REQUESTS_PER_THREAD = 6
BATCH = 4


def test_concurrent_appends_produce_gapless_contiguous_seq(live_server):
    group = new_group()
    start = threading.Barrier(THREADS)

    def writer(_: int) -> list[tuple[list[str], dict]]:
        done = []
        with httpx.Client(base_url=live_server, headers=group.headers, timeout=30) as http:
            start.wait()
            for _ in range(REQUESTS_PER_THREAD):
                envelopes = [envelope(size=64) for _ in range(BATCH)]
                response = http.post(group.events, json=batch(*envelopes))
                assert response.status_code == 200, response.text
                done.append(([e["id"] for e in envelopes], response.json()))
        return done

    with ThreadPoolExecutor(THREADS) as pool:
        results = [item for items in pool.map(writer, range(THREADS)) for item in items]

    total = THREADS * REQUESTS_PER_THREAD * BATCH
    with httpx.Client(base_url=live_server, headers=group.headers) as http:
        events, since, more = [], 0, True
        while more:
            page = http.get(group.events, params={"since": since, "limit": 50}).json()
            events += page["events"]
            since, more = page["next"], page["more"]

    assert [e["seq"] for e in events] == list(range(1, total + 1))  # no gaps, no duplicates
    seq_of = {e["id"]: e["seq"] for e in events}
    received_at = {e["id"]: e["received_at"] for e in events}
    assert len(seq_of) == total
    assert len({ack["epoch"] for _, ack in results}) == 1
    for ids, ack in results:
        seqs = [seq_of[i] for i in ids]
        assert seqs == list(range(seqs[0], seqs[0] + BATCH))  # contiguous, in request order
        assert (ack["accepted"], ack["duplicates"], ack["seq"]) == (BATCH, 0, seqs[-1])
        # One received_at per request, reported alike by push and pull.
        assert ack["received_at"] == [received_at[i] for i in ids] == [ack["received_at"][0]] * BATCH
    # Strictly increasing across requests, in seq order, however close together they arrived.
    by_seq = [ack["received_at"][0] for _, ack in sorted(results, key=lambda r: seq_of[r[0][0]])]
    assert all(earlier < later for earlier, later in zip(by_seq, by_seq[1:]))
