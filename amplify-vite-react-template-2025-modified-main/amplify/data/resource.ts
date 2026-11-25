import { type ClientSchema, a, defineData } from "@aws-amplify/backend";
import { graphqlIoTCoreTelemetry } from '../functions/graphqlIoTCoreTelemetry/resource';
import { graphqlIoTCoreStatus } from '../functions/graphqlIoTCoreStatus/resource';
import { pollSmhi } from '../jobs/pollSmhi/resource';
import { updateDeviceShadow } from '../functions/updateDeviceShadow/resource';
import { storeDeviceShadow } from '../functions/storeDeviceShadow/resource';

const schema = a.schema({

  Devices: a
    .model({
      device_id: a.string().required(),
      owner: a.string().required(),
      device_type: a.string().required(),
      status: a.string(),
      webhook_url: a.string(),
      webhook_telemetry_enabled: a.boolean(),
      webhook_status_enabled: a.boolean(),
      shadow_desired: a.json(),
      shadow_reported: a.json(),
      min_temperature: a.float(),
      max_temperature: a.float(),
      alarm_state: a.enum(["NORMAL", "TOO_COLD", "TOO_HOT"]),
    })
    .identifier(['device_id'])
    .authorization((allow) => [
      allow.owner(),
      allow.publicApiKey(),
    ]),

  Telemetry: a
    .model({
      device_id: a.string().required(),
      timestamp: a.string().required(),
      temperature: a.float(),
      humidity: a.float(),
      owner: a.string().required()
    })
    .identifier(['device_id', 'timestamp'])
    .authorization((allow) => [
      allow.owner(),
      allow.publicApiKey(),
    ]),

  UpdateDeviceShadow: a
    .mutation()
    .arguments({
      device_id: a.string().required(),
      sendInterval: a.integer().required(),
    })
    .returns(a.string())
    .authorization((allow) => [allow.authenticated()])
    .handler(a.handler.function(updateDeviceShadow)),
  RequestTemperature: a
    .mutation()
    .arguments({
      device_id: a.string().required(),
      shadowRequestTemp: a.boolean().required(),
    })
    .returns(a.string())
    .authorization((allow) => [allow.authenticated()])
    .handler(a.handler.function(updateDeviceShadow)),
  DeviceSendInterval: a.customType({
    desired: a.integer(),
    reported: a.integer(),
  }),

  GetDeviceSendInterval: a
    .query()
    .arguments({ device_id: a.string().required() })
    .returns(a.ref("DeviceSendInterval"))
    .authorization((allow) => [allow.authenticated()])
    .handler(a.handler.function(updateDeviceShadow)),

}).authorization((allow) => [
  allow.resource(graphqlIoTCoreTelemetry).to(['query', 'mutate']),
  allow.resource(graphqlIoTCoreStatus).to(['query', 'mutate']),
  allow.resource(pollSmhi).to(['query', 'mutate']),
  allow.resource(updateDeviceShadow).to(['query', 'mutate']),
  allow.resource(storeDeviceShadow).to(['query', 'mutate'])
]);



export type Schema = ClientSchema<typeof schema>;

export const data = defineData({
  schema,
  authorizationModes: {
    defaultAuthorizationMode: "userPool",
    apiKeyAuthorizationMode: {
      expiresInDays: 365,
    },
  },
});
