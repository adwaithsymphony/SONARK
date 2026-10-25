"""Command line interface.

  sonark node     --id n1 --port 9101 --data ./data/n1
  sonark init     --nodes n1=http://127.0.0.1:9101,... --k 4 --m 2
  sonark put      FILE [--name NAME]
  sonark get      NAME_OR_ID OUT [--repair]
  sonark ls | status | events
  sonark scrub    [--repair] [FILE]
  sonark repaird  [--interval 30]
  sonark gc | rm NAME_OR_ID
  sonark demo
  sonark init-local --dir DIR --nodes 6 [--k 4 --m 2 --base-port 9301]
  sonark serve    [--manage] [--port 8800]
  sonark twin     [--no-verify] [--json]
  sonark preview  NODE [NODE ...] [--no-verify] [--json]
  sonark stop-local
  sonark twin-demo
"""

from __future__ import annotations

import argparse
import os
import sys
import time
from pathlib import Path

from .store import DEFAULT_CHUNK_SIZE, ClusterConfig, Sonark, SonarkError

DEFAULT_CLUSTER = os.environ.get("SONARK_CLUSTER", "sonark-cluster/cluster.json")


def _open(args) -> Sonark:
    path = Path(args.cluster)
    if not path.exists():
        raise SonarkError(f"cluster config not found: {path} (run `sonark init` first)")
    return Sonark(ClusterConfig.load(path))


def _human(n: int) -> str:
    for unit in ("B", "KiB", "MiB", "GiB"):
        if n < 1024 or unit == "GiB":
            return f"{n:.0f} {unit}" if unit == "B" else f"{n:.1f} {unit}"
        n /= 1024
    return str(n)


def print_scrub(report) -> None:
    print(f"checked {report.files_checked} files, {report.chunks_checked} chunks, "
          f"{report.shards_checked} shards")
    for issue in report.issues:
        print("  " + str(issue))
    if report.healthy:
        print("all shards intact")
    else:
        print(f"issues: {len(report.issues)}  repaired: {report.repaired}  "
              f"unrepaired: {report.unrepaired}  lost chunks: {len(report.lost_chunks)}")


def cmd_node(args) -> int:
    from .node import NodeServer
    server = NodeServer(args.id, args.data, host=args.host, port=args.port,
                        verbose=args.verbose)
    print(f"node {args.id} serving {Path(args.data).resolve()} at {server.url}", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    return 0


def cmd_init(args) -> int:
    nodes = {}
    for item in args.nodes.split(","):
        nid, _, url = item.partition("=")
        if not url:
            raise SonarkError(f"bad node spec {item!r}, expected id=url")
        nodes[nid.strip()] = url.strip()
    path = Path(args.cluster)
    path.parent.mkdir(parents=True, exist_ok=True)
    ClusterConfig(nodes=nodes, k=args.k, m=args.m, chunk_size=args.chunk_size).save(path)
    print(f"wrote {path} ({len(nodes)} nodes, k={args.k}, m={args.m})")
    return 0


def cmd_put(args) -> int:
    with _open(args) as s:
        f = s.put_file(args.file, args.name)
    print(f"stored {f.name} as {f.file_id}  {_human(f.size)}  {f.chunk_count} chunks  "
          f"sha256={f.sha256}")
    return 0


def cmd_get(args) -> int:
    with _open(args) as s:
        report = s.get_file(args.ref, args.out)
        print(f"wrote {args.out}  {_human(report.file.size)}  sha256 verified")
        if report.degraded:
            print(f"degraded read: {len(report.issues)} bad shards, "
                  f"{report.reconstructed_chunks} chunks rebuilt")
            for issue in report.issues:
                print("  " + str(issue))
            if args.repair:
                print_scrub(s.scrub(repair=True, ref=report.file.file_id))
    return 0


def cmd_ls(args) -> int:
    with _open(args) as s:
        for f in s.meta.list_files():
            print(f"{f.file_id}  {_human(f.size):>10}  k={f.k} m={f.m}  "
                  f"{f.chunk_count:>4} chunks  {f.created_at}  {f.name}")
    return 0


def cmd_status(args) -> int:
    with _open(args) as s:
        st = s.status()
    print(f"k={st['k']} m={st['m']}  files={st['files']}  bytes={_human(st['bytes'])}")
    for nid, n in st["nodes"].items():
        print(f"  {nid:<6} {'UP  ' if n['up'] else 'DOWN'}  {n['shards']:>5} shards  {n['url']}")
    return 0


def cmd_scrub(args) -> int:
    with _open(args) as s:
        report = s.scrub(repair=args.repair, ref=args.ref)
    print_scrub(report)
    return 0 if report.healthy or (args.repair and report.unrepaired == 0) else 1


def cmd_repaird(args) -> int:
    with _open(args) as s:
        print(f"repair daemon: scrubbing every {args.interval}s (Ctrl+C to stop)", flush=True)
        try:
            while True:
                report = s.scrub(repair=True)
                stamp = time.strftime("%H:%M:%S")
                if report.healthy:
                    print(f"[{stamp}] {report.shards_checked} shards intact", flush=True)
                else:
                    print(f"[{stamp}]", end=" ")
                    print_scrub(report)
                    sys.stdout.flush()
                time.sleep(args.interval)
        except KeyboardInterrupt:
            pass
    return 0


def cmd_gc(args) -> int:
    with _open(args) as s:
        removed = s.gc()
    for nid, n in removed.items():
        print(f"  {nid}: removed {n} orphan shards")
    return 0


def cmd_rm(args) -> int:
    with _open(args) as s:
        f = s.delete(args.ref)
    print(f"deleted {f.name} ({f.file_id})")
    return 0


def cmd_events(args) -> int:
    with _open(args) as s:
        for ts, kind, fid, ci, si, nid, detail in reversed(s.meta.events(args.limit)):
            loc = f" file={fid[:8]}" if fid else ""
            loc += f" chunk={ci}" if ci is not None else ""
            loc += f" shard={si}" if si is not None else ""
            loc += f" node={nid}" if nid else ""
            print(f"{ts}  {kind:<9}{loc}  {detail or ''}")
    return 0


def cmd_demo(args) -> int:
    from .demo import run
    return run(nodes=args.nodes, k=args.k, m=args.m, size_mib=args.size, keep=args.keep)


def cmd_init_local(args) -> int:
    root = Path(args.dir)
    root.mkdir(parents=True, exist_ok=True)
    path = root / "cluster.json"
    if path.exists() and not args.force:
        raise SonarkError(f"{path} already exists (use --force to overwrite the config; "
                          "node data and metadata are left untouched)")
    nodes = {f"n{i}": f"http://127.0.0.1:{args.base_port + i}" for i in range(1, args.nodes + 1)}
    ClusterConfig(nodes=nodes, k=args.k, m=args.m, chunk_size=args.chunk_size).save(path)
    print(f"wrote {path}: {args.nodes} loopback nodes on ports "
          f"{args.base_port + 1}-{args.base_port + args.nodes}, k={args.k}, m={args.m}")
    print(f"next: python -m sonark --cluster {path} serve --manage")
    return 0


def cmd_serve(args) -> int:
    from .api import ApiServer, SonarkAPI
    from .supervisor import NodeSupervisor
    path = Path(args.cluster)
    if not path.exists():
        raise SonarkError(f"cluster config not found: {path}")
    config = ClusterConfig.load(path)
    supervisor = None
    if args.manage:
        supervisor = NodeSupervisor(config, log_dir=Path(config.base_dir) / "logs")
        for nid, outcome in supervisor.start_all().items():
            print(f"  {nid}: {outcome}", flush=True)
    store = Sonark(config, threadsafe_metadata=True)
    api = SonarkAPI(store, supervisor, max_upload=int(args.max_upload_mib * 1024 * 1024))
    try:
        server = ApiServer(api, host=args.host, port=args.port, allow_remote=args.allow_remote,
                           cors_origins=tuple(args.cors_origin or ()), verbose=args.verbose)
        print(f"Sonark API on {server.url}/api  (node control: "
              f"{'on' if supervisor else 'off'}, read-only: {api.read_only})", flush=True)
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        store.close()
        if supervisor:
            supervisor.stop_all()
    return 0


def _print_twin(result: dict) -> None:
    sm = result["summary"]
    print(f"snapshot {result['snapshot']['taken_at']}  verified={result['snapshot']['verified']}")
    print(f"files={sm['files']}  status={sm['status_counts']}  "
          f"cluster fault tolerance={sm['cluster_fault_tolerance']} node(s)")
    for f in result["files"]:
        print(f"  {f['name']:<24} {f['status']:<9} coding={','.join(f['coding']) or '-':<6} "
              f"tolerates={f['fault_tolerance']}  minimal loss sets={f['minimal_loss_sets_total']}")
        print(f"    {f['explanation']}")
    shown = result["cluster_minimal_loss_sets"][:10]
    if shown:
        print("smallest cluster-wide loss sets:")
        for s in shown:
            print(f"  {{{', '.join(s['nodes'])}}} -> loses {len(s['files_lost'])} file(s)")


def cmd_twin(args) -> int:
    import json as _json
    from .twin import analyze, observe
    with _open(args) as s:
        result = analyze(observe(s, verify=not args.no_verify))
    if args.json:
        print(_json.dumps(result, indent=2))
    else:
        _print_twin(result)
    return 0


def cmd_preview(args) -> int:
    import json as _json
    from .twin import observe, preview
    with _open(args) as s:
        try:
            p = preview(observe(s, verify=not args.no_verify), args.nodes)
        except ValueError as e:
            raise SonarkError(str(e)) from None
    if args.json:
        print(_json.dumps(p, indent=2))
        return 0
    print(f"{p['scenario_id']}: fail {', '.join(p['nodes'])}")
    print(p["explanation"])
    for f in p["files"]:
        print(f"  {f['name']:<24} {f['status_before']} -> {f['status_after']}: {f['explanation']}")
    return 0


def cmd_stop_local(args) -> int:
    from .supervisor import stop_stale
    for nid, outcome in stop_stale(ClusterConfig.load(args.cluster)).items():
        print(f"  {nid}: {outcome}")
    return 0


def cmd_twin_demo(args) -> int:
    from .twin_demo import run
    return run(keep=args.keep, json_out=args.json_out)


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="sonark", description=__doc__,
                                formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--cluster", default=DEFAULT_CLUSTER,
                   help=f"cluster config file (default {DEFAULT_CLUSTER}, env SONARK_CLUSTER)")
    sub = p.add_subparsers(dest="cmd", required=True)

    n = sub.add_parser("node", help="run a storage node")
    n.add_argument("--id", required=True)
    n.add_argument("--data", required=True)
    n.add_argument("--host", default="127.0.0.1")
    n.add_argument("--port", type=int, required=True)
    n.add_argument("--verbose", action="store_true")
    n.set_defaults(fn=cmd_node)

    i = sub.add_parser("init", help="write a cluster config")
    i.add_argument("--nodes", required=True, help="id=url,id=url,...")
    i.add_argument("--k", type=int, default=4)
    i.add_argument("--m", type=int, default=2)
    i.add_argument("--chunk-size", type=int, default=DEFAULT_CHUNK_SIZE)
    i.set_defaults(fn=cmd_init)

    pu = sub.add_parser("put", help="store a file")
    pu.add_argument("file")
    pu.add_argument("--name")
    pu.set_defaults(fn=cmd_put)

    g = sub.add_parser("get", help="retrieve a file")
    g.add_argument("ref", help="file name or id")
    g.add_argument("out")
    g.add_argument("--repair", action="store_true", help="repair any bad shards found")
    g.set_defaults(fn=cmd_get)

    sub.add_parser("ls", help="list files").set_defaults(fn=cmd_ls)
    sub.add_parser("status", help="node health and shard counts").set_defaults(fn=cmd_status)

    sc = sub.add_parser("scrub", help="verify every shard (optionally repair)")
    sc.add_argument("ref", nargs="?")
    sc.add_argument("--repair", action="store_true")
    sc.set_defaults(fn=cmd_scrub)

    rd = sub.add_parser("repaird", help="scrub and repair continuously")
    rd.add_argument("--interval", type=float, default=30.0)
    rd.set_defaults(fn=cmd_repaird)

    sub.add_parser("gc", help="remove orphaned shards from nodes").set_defaults(fn=cmd_gc)

    r = sub.add_parser("rm", help="delete a file")
    r.add_argument("ref")
    r.set_defaults(fn=cmd_rm)

    e = sub.add_parser("events", help="show the event log")
    e.add_argument("--limit", type=int, default=50)
    e.set_defaults(fn=cmd_events)

    d = sub.add_parser("demo", help="run the end-to-end failure demo")
    d.add_argument("--nodes", type=int, default=6)
    d.add_argument("--k", type=int, default=4)
    d.add_argument("--m", type=int, default=2)
    d.add_argument("--size", type=float, default=6.0, help="test file size in MiB")
    d.add_argument("--keep", action="store_true", help="keep the demo directory")
    d.set_defaults(fn=cmd_demo)

    il = sub.add_parser("init-local", help="create a cluster config for local managed nodes")
    il.add_argument("--dir", required=True)
    il.add_argument("--nodes", type=int, default=6)
    il.add_argument("--k", type=int, default=4)
    il.add_argument("--m", type=int, default=2)
    il.add_argument("--base-port", type=int, default=9300)
    il.add_argument("--chunk-size", type=int, default=1024 * 1024)
    il.add_argument("--force", action="store_true")
    il.set_defaults(fn=cmd_init_local)

    sv = sub.add_parser("serve", help="run the local JSON API")
    sv.add_argument("--host", default="127.0.0.1")
    sv.add_argument("--port", type=int, default=8800)
    sv.add_argument("--manage", action="store_true",
                    help="start the cluster's node processes and allow controlled failures")
    sv.add_argument("--allow-remote", action="store_true",
                    help="allow a non-loopback bind (API becomes read-only)")
    sv.add_argument("--cors-origin", action="append",
                    help="allow this browser origin (repeatable), e.g. http://localhost:5173")
    sv.add_argument("--max-upload-mib", type=float, default=64)
    sv.add_argument("--verbose", action="store_true")
    sv.set_defaults(fn=cmd_serve)

    sl = sub.add_parser("stop-local", help="kill node processes left by an unclean serve exit")
    sl.set_defaults(fn=cmd_stop_local)

    tw = sub.add_parser("twin", help="Survival Twin analysis of the cluster")
    tw.add_argument("--no-verify", action="store_true", help="health only, skip shard hashing")
    tw.add_argument("--json", action="store_true")
    tw.set_defaults(fn=cmd_twin)

    pv = sub.add_parser("preview", help="predict the effect of failing nodes (non-destructive)")
    pv.add_argument("nodes", nargs="+")
    pv.add_argument("--no-verify", action="store_true")
    pv.add_argument("--json", action="store_true")
    pv.set_defaults(fn=cmd_preview)

    td = sub.add_parser("twin-demo", help="deterministic Survival Twin fixture with real failures")
    td.add_argument("--keep", action="store_true")
    td.add_argument("--json-out", help="write the full results as JSON to this path")
    td.set_defaults(fn=cmd_twin_demo)
    return p


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        return args.fn(args)
    except SonarkError as e:
        print(f"error: {e}", file=sys.stderr)
        return 2
