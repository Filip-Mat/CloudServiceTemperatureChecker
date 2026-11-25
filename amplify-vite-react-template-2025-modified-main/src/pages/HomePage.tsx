import { useEffect, useRef, useState } from "react";
import { Button, SelectField } from "@aws-amplify/ui-react";
import { generateClient } from "aws-amplify/data";
import {
  CategoryScale,
  Chart as ChartJS,
  Legend,
  LinearScale,
  LineElement,
  PointElement,
  Tooltip,
} from "chart.js";
import { Line } from "react-chartjs-2";
import type { Schema } from "../../amplify/data/resource";

ChartJS.register(
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  Tooltip,
  Legend,
);

const client = generateClient<Schema>({ authMode: "userPool" });

type Device = Schema["Devices"]["type"];
type Reading = Schema["Telemetry"]["type"];

export default function HomePage({
  devices,
  selectedId,
  onSelect,
  onOpenDevices,
}: {
  devices: Device[];
  selectedId: string;
  onSelect: (id: string) => void;
  onOpenDevices: () => void;
}) {
  const device = devices.find((item) => item.device_id === selectedId);

  return (
    <section>
      <div className="page-heading">
        <h1>Temperature history</h1>
      </div>

      <div className="dashboard-panel">
        <div className="graph-controls">
          <SelectField
            label="Device"
            value={device?.device_id ?? ""}
            onChange={(event) => onSelect(event.target.value)}
          >
            <option value="">Select a device</option>

            {devices.map((item) => (
              <option key={item.device_id} value={item.device_id}>
                {item.device_id}
              </option>
            ))}
          </SelectField>
        </div>

        {device ? (
          <TemperatureGraph
            key={device.device_id}
            deviceId={device.device_id}
            isEsp32={device.device_type === "esp32"}
          />
        ) : (
          <div className="dashboard-empty">
            {devices.length ? (
              <p>Select a device to see its temperature readings.</p>
            ) : (
              <>
                <p>Register a device to start seeing temperature readings.</p>
                <Button onClick={onOpenDevices}>Open Devices</Button>
              </>
            )}
          </div>
        )}
      </div>
    </section>
  );
}

function TemperatureGraph({
  deviceId,
  isEsp32,
}: {
  deviceId: string;
  isEsp32: boolean;
}) {
  const [readings, setReadings] = useState<Reading[]>([]);
  const [synced, setSynced] = useState(false);
  const [error, setError] = useState("");

  const [sending, setSending] = useState(false);
  const [waitingAfter, setWaitingAfter] = useState<number | null>(null);
  const [requestMessage, setRequestMessage] = useState("");

  // Prevent a second click before React has updated the button state.
  const requestInProgress = useRef(false);

  useEffect(() => {
    const subscription = client.models.Telemetry.observeQuery({
      filter: { device_id: { eq: deviceId } },
    }).subscribe({
      next: ({ items, isSynced }) => {
        setReadings(
          items
            .filter((item) => item.temperature != null)
            .sort((a, b) => Number(a.timestamp) - Number(b.timestamp)),
        );

        setSynced(isSynced);
        setError("");
      },
      error: () => setError("Could not load temperature readings."),
    });

    return () => subscription.unsubscribe();
  }, [deviceId]);

  const latestReading = readings[readings.length - 1];

  const newReading = waitingAfter === null
    ? undefined
    : readings.find((item) => Number(item.timestamp) > waitingAfter);

  const waiting = waitingAfter !== null && !newReading;

  useEffect(() => {
    if (sending || !newReading) return;

    setRequestMessage("");
    setWaitingAfter(null);
    requestInProgress.current = false;
  }, [sending, newReading]);

  useEffect(() => {
    if (sending || !waiting) return;

    const timer = window.setTimeout(() => {
      setWaitingAfter(null);
      setRequestMessage(
        "No new reading arrived within 20 seconds. Check the ESP32 connection.",
      );
      requestInProgress.current = false;
    }, 20_000);

    return () => window.clearTimeout(timer);
  }, [sending, waiting]);

  async function checkTemperature() {
    if (requestInProgress.current) return;

    requestInProgress.current = true;
    setSending(true);
    setRequestMessage("");

    // Set this before the API call so a fast reading is still noticed.
    setWaitingAfter(
      latestReading ? Number(latestReading.timestamp) : 0,
    );

    try {
      const { data, errors } = await client.mutations.RequestTemperature({
        device_id: deviceId,
        shadowRequestTemp: true,
      });

      if (errors?.length || data !== "ok") {
        throw new Error(errors?.[0]?.message ?? "Could not request temperature.");
      }
    } catch (requestError) {
      setWaitingAfter(null);
      setRequestMessage(
        requestError instanceof Error
          ? requestError.message
          : "Could not request temperature.",
      );
      requestInProgress.current = false;
    } finally {
      setSending(false);
    }
  }

  return (
    <>
      {latestReading && (
        <p role="status">
          Latest temperature: <strong>{latestReading.temperature} °C</strong>
        </p>
      )}
      {isEsp32 && (
        <div>
          <Button
            variation="primary"
            isDisabled={!synced || Boolean(error) || sending || waiting}
            onClick={() => void checkTemperature()}
          >
            {sending
              ? "Sending request…"
              : waiting
                ? "Waiting for temperature…"
                : "Check temperature"}
          </Button>

          {requestMessage && <p role="status">{requestMessage}</p>}
        </div>
      )}

      {error ? (
        <p className="dashboard-error" role="alert">{error}</p>
      ) : !readings.length ? (
        <p className="dashboard-empty">
          {synced ? "No readings yet." : "Loading readings…"}
        </p>
      ) : (
        <div className="temperature-chart">
          <Line
            aria-label="Temperature over time"
            options={{
              responsive: true,
              maintainAspectRatio: false,
              plugins: { legend: { display: false } },
              scales: {
                x: {
                  grid: { display: false },
                  ticks: { maxTicksLimit: 8 },
                },
                y: {
                  title: { display: true, text: "°C" },
                  grid: { color: "#e8edf0" },
                },
              },
            }}
            data={{
              labels: readings.map(({ timestamp }) =>
                new Date(Number(timestamp)).toLocaleString(),
              ),
              datasets: [{
                label: "Temperature (°C)",
                data: readings.map(({ temperature }) => temperature ?? null),
                borderColor: "#087e75",
                pointRadius: readings.length > 30 ? 0 : 3,
                pointHoverRadius: 5,
                tension: 0.18,
              }],
            }}
          />
        </div>
      )}
    </>
  );
}
