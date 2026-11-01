import { useState } from "react";
import { useAuth } from "../contexts/AuthContext";
import { DIRECTOR_VERSION } from "../lib/director";
import {
  compareDirectors,
  directorGate,
  poolComparisons,
  type DirectorComparison,
  type GateCheck,
} from "../lib/directorCompare";
import { onDeviceModelReady } from "../lib/native/appleAI";
import { directLinesOnDevice, directorLines } from "../lib/onDeviceDirector";
import { listScripts } from "../lib/scriptStore";

// How many saved scripts one run directs. Each takes the on-device model
// several seconds per chunk, so a run stays a few minutes at most.
const MAX_SCRIPTS = 6;

type ScriptResult = { title: string; seconds: number; comparison: DirectorComparison };

const pct = (value: number | null) => (value === null ? "—" : `${Math.round(value * 100)}%`);

/**
 * Admin, iOS app only: runs the on-device director over this account's saved
 * scripts that already carry the cloud director's markup, and scores the
 * two against each other (lib/directorCompare.ts). The gate it prints is
 * what has to pass before VITE_ON_DEVICE_DIRECTOR is turned on. Results are
 * also logged as JSON for keeping a record.
 */
export default function OnDeviceDirectorCheck() {
  const { user } = useAuth();
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<string | null>(null);
  const [results, setResults] = useState<ScriptResult[]>([]);
  const [gate, setGate] = useState<GateCheck[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function run() {
    if (!user) return;
    setRunning(true);
    setError(null);
    setResults([]);
    setGate(null);
    try {
      if (!(await onDeviceModelReady("en"))) {
        setError("Apple's on-device model isn't available on this device (iOS 26 with Apple Intelligence on).");
        return;
      }
      const scripts = (await listScripts(user.id))
        .filter(
          (script) =>
            script.delivery_tags?.length === script.steps.length &&
            script.director_version === DIRECTOR_VERSION &&
            script.language_code === "en",
        )
        .slice(0, MAX_SCRIPTS);
      if (!scripts.length) {
        setError("No saved English scripts with current cloud direction to compare against. Rehearse a script in the browser first.");
        return;
      }
      const done: ScriptResult[] = [];
      for (const [index, script] of scripts.entries()) {
        setProgress(`Directing ${index + 1} of ${scripts.length}: ${script.title}`);
        const lines = directorLines(script.steps);
        const started = performance.now();
        const onDevice = await directLinesOnDevice(lines);
        done.push({
          title: script.title,
          seconds: (performance.now() - started) / 1000,
          comparison: compareDirectors(
            lines.map((line) => line.text),
            script.delivery_tags!,
            onDevice.tags,
            onDevice,
          ),
        });
        setResults([...done]);
      }
      const pooled = poolComparisons(done.map((result) => result.comparison));
      setGate(directorGate(pooled));
      console.log("On-device director check", JSON.stringify({ directorVersion: DIRECTOR_VERSION, pooled, scripts: done }));
    } catch (err) {
      setError(`The check stopped: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setRunning(false);
      setProgress(null);
    }
  }

  return (
    <section className="admin-panel director-check" aria-labelledby="director-check-title">
      <h2 id="director-check-title">On-device director</h2>
      <p className="admin-panel-sub">
        Directs your saved scripts with Apple's on-device model and compares it with the cloud director.
      </p>
      <button type="button" className="director-check-run" onClick={run} disabled={running}>
        {running ? "Running…" : "Run check"}
      </button>
      {progress && <p className="admin-panel-sub">{progress}</p>}
      {error && (
        <p className="admin-error" role="alert">
          {error}
        </p>
      )}
      {results.length > 0 && (
        <table className="director-check-table">
          <thead>
            <tr>
              <th scope="col">Script</th>
              <th scope="col">Directed (device / cloud)</th>
              <th scope="col">Agree</th>
              <th scope="col">Beats found</th>
              <th scope="col">Time</th>
            </tr>
          </thead>
          <tbody>
            {results.map(({ title, seconds, comparison }) => (
              <tr key={title}>
                <th scope="row">{title}</th>
                <td>
                  {pct(comparison.onDeviceDirectedRate)} / {pct(comparison.cloudDirectedRate)}
                </td>
                <td>{pct(comparison.directedAgreement)}</td>
                <td>{pct(comparison.beatRecall)}</td>
                <td>{seconds.toFixed(0)}s</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {gate && (
        <ul className="director-check-gate" aria-label="Gate">
          {gate.map((check) => (
            <li key={check.name} className={check.pass ? "is-pass" : "is-fail"}>
              <strong>
                {check.pass ? "Pass" : "Fail"} · {check.name}
              </strong>
              <span>{check.detail}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
