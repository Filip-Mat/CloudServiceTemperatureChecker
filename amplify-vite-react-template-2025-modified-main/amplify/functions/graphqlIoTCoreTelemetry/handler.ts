import type { Handler } from "aws-lambda";
import { Amplify } from "aws-amplify";
import { generateClient } from "aws-amplify/data";
import { getAmplifyDataClientConfig } from "@aws-amplify/backend/function/runtime";
import { env } from "$amplify/env/graphqlIoTCoreTelemetry";
import type { Schema } from "../../data/resource";

const { resourceConfig, libraryOptions } =
  await getAmplifyDataClientConfig(env);

Amplify.configure(resourceConfig, libraryOptions);

const client = generateClient<Schema>({ authMode: "iam" });

type TelemetryEvent = {
  device_id: string;
  timestamp: string | number;
  temperature: number;
};

function getAlarmState(temperature: number, min: number, max: number) {
  if (temperature < min) return "TOO_COLD";
  if (temperature > max) return "TOO_HOT";
  return "NORMAL";
}

export const handler: Handler<TelemetryEvent> = async (event) => {
  const { device_id, temperature } = event;
  const timestamp = String(event.timestamp);

  if (!device_id || !Number.isFinite(temperature) || !/^\d+$/.test(timestamp)) {
    console.warn("Ignoring invalid telemetry", { device_id });
    return;
  }

  const { data: device, errors: lookupErrors } =
    await client.models.Devices.get({ device_id });

  if (lookupErrors?.length) {
    throw new Error(lookupErrors[0].message);
  }

  if (!device?.owner) {
    console.info("Ignoring telemetry from an unregistered device", { device_id });
    return;
  }

  const { errors: createErrors } = await client.models.Telemetry.create({
    device_id,
    timestamp,
    temperature,
    owner: device.owner,
  });

  if (createErrors?.length) {
    throw new Error(createErrors[0].message);
  }

  const min = device.min_temperature;
  const max = device.max_temperature;

  if (min == null || max == null || min >= max) return;

  const previousState = device.alarm_state ?? "NORMAL";
  const nextState = getAlarmState(temperature, min, max);

  if (nextState === previousState) return;

  const { errors: updateErrors } = await client.models.Devices.update({
    device_id,
    alarm_state: nextState,
  });

  if (updateErrors?.length) {
    throw new Error(updateErrors[0].message);
  }

  if (!device.webhook_telemetry_enabled || !device.webhook_url) return;

  const messages = {
    TOO_COLD: `Too cold: ${temperature} °C. Minimum: ${min} °C.`,
    TOO_HOT: `Too hot: ${temperature} °C. Maximum: ${max} °C.`,
    NORMAL: `Back to normal: ${temperature} °C. Range: ${min}–${max} °C.`,
  };

  try {
    const response = await fetch(device.webhook_url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        content: `${device_id}\n${messages[nextState]}`,
        allowed_mentions: { parse: [] },
      }),
    });

    if (!response.ok) {
      console.error("Discord rejected the temperature alert", {
        device_id,
        status: response.status,
      });
    }
  } catch {
    console.error("Could not send the temperature alert", { device_id });
  }
};