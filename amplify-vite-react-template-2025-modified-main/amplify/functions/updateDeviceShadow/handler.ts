import { IoTClient, DescribeEndpointCommand } from "@aws-sdk/client-iot";
import {
  GetThingShadowCommand,
  IoTDataPlaneClient,
  ResourceNotFoundException,
  UpdateThingShadowCommand,
} from "@aws-sdk/client-iot-data-plane";
import { Amplify } from "aws-amplify";
import { generateClient } from "aws-amplify/data";
import { getAmplifyDataClientConfig } from "@aws-amplify/backend/function/runtime";
import { env } from "$amplify/env/updateDeviceShadow";
import type { Schema } from "../../data/resource";

const { resourceConfig, libraryOptions } =
  await getAmplifyDataClientConfig(env);

Amplify.configure(resourceConfig, libraryOptions);

const client = generateClient<Schema>({ authMode: "iam" });

type ShadowEvent =
  | Parameters<Schema["UpdateDeviceShadow"]["functionHandler"]>[0]
  | Parameters<Schema["GetDeviceSendInterval"]["functionHandler"]>[0]
  | Parameters<Schema["RequestTemperature"]["functionHandler"]>[0];

let iotData: IoTDataPlaneClient | undefined;

function readInterval(value: unknown) {
  return typeof value === "number" &&
    Number.isInteger(value) &&
    value > 0 &&
    value <= 2_147_483_647
    ? value
    : null;
}

export const handler = async (event: ShadowEvent) => {
  const { device_id } = event.arguments;

  const userId =
    event.identity && "sub" in event.identity
      ? event.identity.sub
      : undefined;

  const { data: device, errors } = await client.models.Devices.get({
    device_id,
  });

  if (
    errors?.length ||
    !device ||
    !userId ||
    device.owner?.split("::")[0] !== userId
  ) {
    throw new Error("Not the owner");
  }

  if (device.device_type !== "esp32") {
    throw new Error("Shadow commands are only supported for an ESP32");
  }

  if (!iotData) {
    const { endpointAddress } = await new IoTClient({}).send(
      new DescribeEndpointCommand({ endpointType: "iot:Data-ATS" }),
    );

    if (!endpointAddress) {
      throw new Error("AWS IoT data endpoint is unavailable");
    }

    iotData = new IoTDataPlaneClient({
      endpoint: `https://${endpointAddress}`,
    });
  }

  // NEW: Ask the ESP32 for an immediate reading.
  if ("shadowRequestTemp" in event.arguments) {
    if (event.arguments.shadowRequestTemp !== true) {
      throw new Error("Set shadowRequestTemp to true to request a reading");
    }
    await iotData.send(
      new UpdateThingShadowCommand({
        thingName: device_id,
        payload: Buffer.from(
          JSON.stringify({
            state: {
              desired: {
                shadowRequestTemp: true,
              },
            },
          }),
        ),
      }),
    );

    return "ok";
  }

  // Read the ESP32's current interval.
  if (!("sendInterval" in event.arguments)) {
    try {
      const { payload } = await iotData.send(
        new GetThingShadowCommand({
          thingName: device_id,
        }),
      );

      if (!payload) {
        return { desired: null, reported: null };
      }

      const shadow = JSON.parse(Buffer.from(payload).toString("utf8"));

      return {
        desired: readInterval(shadow.state?.desired?.sendInterval),
        reported: readInterval(shadow.state?.reported?.sendInterval),
      };
    } catch (error) {
      if (error instanceof ResourceNotFoundException) {
        return { desired: null, reported: null };
      }

      throw error;
    }
  }

  // Change the send interval.
  const { sendInterval } = event.arguments;

  if (
    !Number.isInteger(sendInterval) ||
    sendInterval < 60 ||
    sendInterval > 2_147_483
  ) {
    throw new Error("Enter an interval between 60 and 2147483 seconds");
  }

  await iotData.send(
    new UpdateThingShadowCommand({
      thingName: device_id,
      payload: Buffer.from(
        JSON.stringify({
          state: {
            desired: {
              sendInterval: sendInterval * 1000,
            },
          },
        }),
      ),
    }),
  );

  const raw = device.shadow_desired;
  const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;

  const currentDesired =
    parsed && typeof parsed === "object"
      ? (parsed as Record<string, unknown>)
      : {};

  const { errors: updateErrors } = await client.models.Devices.update({
    device_id,
    shadow_desired: JSON.stringify({
      ...currentDesired,
      sendInterval: sendInterval * 1000,
    }),
  });

  if (updateErrors?.length) {
    throw new Error(updateErrors[0].message);
  }

  return "ok";
};
