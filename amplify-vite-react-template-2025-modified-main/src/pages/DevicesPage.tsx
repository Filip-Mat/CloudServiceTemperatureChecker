import { useEffect, useState, type FormEvent } from "react";
import {
  Badge, Button, Card, SelectField, SwitchField, TextField,
} from "@aws-amplify/ui-react";
import { generateClient } from "aws-amplify/data";
import moment from "moment";
import type { Schema } from "../../amplify/data/resource";

const client = generateClient<Schema>({ authMode: "userPool" });
type Device = Schema["Devices"]["type"];

function readInterval(value: unknown): number | undefined {
  try {
    const shadow = typeof value === "string" ? JSON.parse(value) : value;
    const interval = shadow?.sendInterval;
    return typeof interval === "number" ? interval : undefined;
  } catch {
    return undefined;
  }
}

function messageFor(error: unknown) {
  return error instanceof Error ? error.message : "Operation failed.";
}

export default function DevicesPage({
  devices,
  owner,
  onViewGraph,
}: {
  devices: Device[];
  owner: string;
  onViewGraph: (id: string) => void;
}) {
  const [deviceId, setDeviceId] = useState("");
  const [deviceType, setDeviceType] = useState("esp32");
  const [registering, setRegistering] = useState(false);
  const [message, setMessage] = useState("");
  const [lastSeen, setLastSeen] = useState<Map<string, number> | null>(null);
  const [lastSeenError, setLastSeenError] = useState(false);

  // Keep Last Seen independent of whichever device is selected on Home.
  useEffect(() => {
    const subscription = client.models.Telemetry.observeQuery().subscribe({
      next: ({ items }) => {
        const latest = new Map<string, number>();

        for (const item of items) {
          const timestamp = Number(item.timestamp);
          if (Number.isFinite(timestamp)) {
            latest.set(
              item.device_id,
              Math.max(latest.get(item.device_id) ?? 0, timestamp),
            );
          }
        }

        setLastSeen(latest);
      },
      error: () => setLastSeenError(true),
    });

    return () => subscription.unsubscribe();
  }, []);

  async function registerDevice(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const id = deviceId.trim();
    if (!id) return;

    setRegistering(true);
    setMessage("");

    try {
      const { data, errors } = await client.models.Devices.create({
        device_id: id,
        device_type: deviceType,
        owner,
      });

      if (errors?.length || !data) {
        throw new Error(errors?.[0]?.message ?? "Could not register device.");
      }

      setDeviceId("");
      setMessage(`Registered ${id}.`);
    } catch (error) {
      setMessage(messageFor(error));
    } finally {
      setRegistering(false);
    }
  }

  return (
    <section>
      <div className="page-heading"><h1>Devices</h1></div>

      <div className="dashboard-panel register-panel">
        <h2>Register a device</h2>
        <form className="register-form" onSubmit={registerDevice}>
          <TextField
            label="Device ID"
            descriptiveText="Enter the AWS IoT Thing name or SMHI station number."
            value={deviceId}
            onChange={(event) => setDeviceId(event.target.value)}
            required
          />

          <SelectField
            label="Type"
            value={deviceType}
            onChange={(event) => setDeviceType(event.target.value)}
          >
            <option value="esp32">ESP32</option>
            <option value="weatherStation">Weather Station</option>
          </SelectField>

          <Button type="submit" variation="primary" isDisabled={registering}>
            {registering ? "Registering…" : "Register device"}
          </Button>
        </form>

        {message && <p role="status">{message}</p>}
      </div>
      {lastSeenError && <p className="dashboard-error" role="alert">Could not load Last Seen data.</p>}

      <div className="device-grid">
        {devices.map((device) => (
          <DeviceCard
            key={device.device_id}
            device={device}
            lastSeen={lastSeen?.get(device.device_id)}
            lastSeenLoading={!lastSeen && !lastSeenError}
            onViewGraph={() => onViewGraph(device.device_id)}
          />
        ))}
      </div>
    </section>
  );
}

function DeviceCard({
  device,
  lastSeen,
  lastSeenLoading,
  onViewGraph,
}: {
  device: Device;
  lastSeen?: number;
  lastSeenLoading: boolean;
  onViewGraph: () => void;
}) {
  const [minInput, setMinInput] = useState(
    device.min_temperature?.toString() ?? "",
  );
  const [maxInput, setMaxInput] = useState(
    device.max_temperature?.toString() ?? "",
  );
  const [message, setMessage] = useState("");
  const [savingLimits, setSavingLimits] = useState(false);
  const [savingInterval, setSavingInterval] = useState(false);
  const [intervalRequest, setIntervalRequest] = useState<{ milliseconds: number }>();
  const [liveShadow, setLiveShadow] = useState<{ desired: number | null; reported: number | null }>();
  const [intervalError, setIntervalError] = useState("");
  const [liveQueryUnavailable, setLiveQueryUnavailable] = useState(false);

  const deviceId = device.device_id;
  const storedDesired = readInterval(device.shadow_desired);
  const storedInterval = readInterval(device.shadow_reported);
  const desired = liveShadow ? liveShadow.desired : storedDesired;
  const reported = liveShadow ? liveShadow.reported : storedInterval;
  const configuredInterval = intervalRequest?.milliseconds ?? desired ?? reported;

  useEffect(() => {
    if (device.device_type !== "esp32") return;

    // Older deployments still deliver confirmed values through Devices.observeQuery.
    if (liveQueryUnavailable) {
      if (intervalRequest && storedInterval === intervalRequest.milliseconds) {
        setIntervalRequest(undefined);
      }
      return;
    }

    const getInterval = client.queries.GetDeviceSendInterval;
    if (typeof getInterval !== "function") {
      setLiveQueryUnavailable(true);
      return;
    }

    let active = true;
    let timer: number | undefined;
    let attempts = 0;
    async function refreshInterval() {
      try {
        const { data, errors } = await getInterval({
          device_id: deviceId,
        });

        if (!active) return;
        if (errors?.some(({ message }) =>
          message.includes("FieldUndefined") && message.includes("GetDeviceSendInterval"),
        )) {
          setLiveShadow(undefined);
          setIntervalError("");
          setLiveQueryUnavailable(true);
          return;
        }

        if (errors?.length || !data) {
          throw new Error(errors?.[0]?.message ?? "No shadow data returned.");
        }

        const current = data.reported ?? null;
        const target = intervalRequest?.milliseconds ?? data.desired;
        setLiveShadow({ desired: data.desired ?? null, reported: current });
        setIntervalError("");

        if (current != null && (target == null || target === current)) {
          if (intervalRequest) setIntervalRequest(undefined);
          return;
        }

        attempts += 1;
        if (attempts < 10) {
          timer = window.setTimeout(() => void refreshInterval(), 2_000);
        } else {
          setIntervalError(target == null
            ? "The ESP32 hasn't reported its current interval yet."
            : "The ESP32 hasn't confirmed the requested interval yet.");
        }
      } catch (error) {
        if (active) setIntervalError(`Could not read the current interval. ${messageFor(error)}`);
      }
    }

    void refreshInterval();

    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [device.device_type, deviceId, intervalRequest, liveQueryUnavailable, storedDesired, storedInterval]);

  async function saveSettings(
    settings: Pick<
      Partial<Device>,
      | "min_temperature"
      | "max_temperature"
      | "webhook_url"
      | "webhook_telemetry_enabled"
      | "webhook_status_enabled"
    >,
    success: string,
  ) {
    try {
      const { errors } = await client.models.Devices.update({
        device_id: deviceId,
        ...settings,
      });

      if (errors?.length) throw new Error(errors[0].message);
      setMessage(success);
    } catch (error) {
      setMessage(messageFor(error));
    }
  }

  async function saveLimits(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    const min = Number(minInput);
    const max = Number(maxInput);

    if (
      !minInput.trim() || !maxInput.trim() ||
      !Number.isFinite(min) || !Number.isFinite(max) || min >= max
    ) {
      setMessage("Enter a minimum below the maximum.");
      return;
    }

    setSavingLimits(true);
    await saveSettings(
      { min_temperature: min, max_temperature: max },
      "Temperature limits saved.",
    );
    setSavingLimits(false);
  }

  async function saveInterval(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const seconds = Number(form.get("sendInterval"));

    if (!Number.isInteger(seconds) || seconds < 60 || seconds > 2_147_483) {
      setMessage("Enter a whole number of seconds between 60 and 2147483.");
      return;
    }

    if (seconds * 1000 === reported && (desired == null || desired === reported)) return;

    setSavingInterval(true);
    setMessage("");
    setIntervalError("");
    try {
      const { errors } = await client.mutations.UpdateDeviceShadow({
        device_id: deviceId,
        sendInterval: seconds,
      });

      if (errors?.length) throw new Error(errors[0].message);
      setIntervalRequest({ milliseconds: seconds * 1000 });
    } catch (error) {
      setMessage(messageFor(error));
    } finally {
      setSavingInterval(false);
    }
  }

  async function deleteDevice() {
    if (!window.confirm(`Remove ${deviceId} from your devices?`)) return;

    try {
      const { errors } = await client.models.Devices.delete({ device_id: deviceId });
      if (errors?.length) throw new Error(errors[0].message);
    } catch (error) {
      setMessage(messageFor(error));
    }
  }

  return (
    <Card className="device-card" variation="outlined">
      <div className="device-card-heading">
        <h2>{deviceId}</h2>
        <Badge variation={device.status === "connected" ? "success" : "info"}>
          {device.status ?? "Unknown"}
        </Badge>
      </div>

      <p className="device-meta">
        Last Seen: {lastSeenLoading ? "Loading…" :
          lastSeen == null ? "—" : moment(lastSeen).fromNow()}
      </p>

      <div className="device-card-actions">
        <Button onClick={onViewGraph}>View graph</Button>
      </div>

      <div className="device-settings">
        <h3>Notifications</h3>
        <TextField
          label="Webhook URL"
          type="password"
          defaultValue={device.webhook_url ?? ""}
          onBlur={(event) => {
            const webhookUrl = event.target.value.trim();
            if (webhookUrl !== (device.webhook_url ?? "")) {
              void saveSettings({ webhook_url: webhookUrl }, "Webhook URL saved.");
            }
          }}
        />

        <SwitchField
          label="Temperature alerts"
          isChecked={device.webhook_telemetry_enabled === true}
          onChange={(event) => void saveSettings(
            { webhook_telemetry_enabled: event.target.checked },
            "Temperature alert preference saved.",
          )}
        />

        <SwitchField
          label="Webhook status enabled"
          isChecked={device.webhook_status_enabled === true}
          onChange={(event) => void saveSettings(
            { webhook_status_enabled: event.target.checked },
            "Status alert preference saved.",
          )}
        />
      </div>

      {device.device_type === "esp32" && (
        <div className="device-settings">
          <h3>Send interval</h3>
          <div className="interval-status" role="status">
            <span>Current: <strong>{reported == null ? "Unknown" : `${reported / 1000} seconds`}</strong></span>
            {configuredInterval != null && configuredInterval !== reported && (
              <span>Pending: {configuredInterval / 1000} seconds</span>
            )}
          </div>
          {intervalError && <p className="dashboard-error" role="alert">{intervalError}</p>}
          <form className="device-form" onSubmit={saveInterval}>
            <TextField
              key={`${deviceId}-${configuredInterval ?? ""}`}
              name="sendInterval"
              label="Send interval (seconds)"
              type="number"
              min={60}
              max={2_147_483}
              required
              defaultValue={configuredInterval == null ? "" : configuredInterval / 1000}
            />
            <Button type="submit" isDisabled={savingInterval}>
              {savingInterval ? "Saving…" : "Save interval"}
            </Button>
          </form>

          <form className="device-form device-settings" onSubmit={saveLimits}>
            <h3>Temperature limits</h3>
            <div className="limit-fields">
              <TextField
                label="Minimum temperature (°C)"
                type="number"
                step="any"
                required
                value={minInput}
                onChange={(event) => setMinInput(event.target.value)}
              />

              <TextField
                label="Maximum temperature (°C)"
                type="number"
                step="any"
                required
                value={maxInput}
                onChange={(event) => setMaxInput(event.target.value)}
              />

            </div>
            <Button type="submit" isDisabled={savingLimits}>
              {savingLimits ? "Saving…" : "Save limits"}
            </Button>
          </form>
        </div>
      )}

      {message && <p role="status">{message}</p>}
      <Button variation="destructive" onClick={() => void deleteDevice()}>
        Delete
      </Button>
    </Card>
  );
}
