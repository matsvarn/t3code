import { describe, expect, it } from "@effect/vitest";
import {
  DEFAULT_SERVER_SETTINGS,
  ProviderDriverKind,
  ProviderInstanceId,
} from "@t3tools/contracts";

import { deriveProviderInstanceConfigMap } from "./ProviderInstanceRegistryHydration.ts";

const devinCloudInstanceId = ProviderInstanceId.make("devin-cloud");

const cloudInstance = (settings: Parameters<typeof deriveProviderInstanceConfigMap>[0]) => {
  const instance = deriveProviderInstanceConfigMap(settings)[devinCloudInstanceId];
  if (!instance) throw new Error("expected devin-cloud instance");
  return instance;
};

describe("deriveProviderInstanceConfigMap", () => {
  it("seeds a Devin Cloud instance mirroring the local devin config", () => {
    const settings = {
      ...DEFAULT_SERVER_SETTINGS,
      providers: {
        ...DEFAULT_SERVER_SETTINGS.providers,
        devin: {
          ...DEFAULT_SERVER_SETTINGS.providers.devin,
          enabled: true,
          binaryPath: "/opt/devin",
        },
      },
    };

    const cloud = cloudInstance(settings);
    expect(cloud.driver).toBe("devin");
    expect(cloud.displayName).toBe("Devin Cloud");
    expect(cloud.config).toMatchObject({
      cloud: true,
      enabled: true,
      binaryPath: "/opt/devin",
    });
  });

  it("keeps Devin Cloud disabled while local devin is disabled", () => {
    const cloud = cloudInstance(DEFAULT_SERVER_SETTINGS);

    expect(cloud.config).toMatchObject({
      cloud: true,
      enabled: false,
    });
  });

  it("does not stomp an explicit devin-cloud instance", () => {
    const settings = {
      ...DEFAULT_SERVER_SETTINGS,
      providerInstances: {
        ...DEFAULT_SERVER_SETTINGS.providerInstances,
        [devinCloudInstanceId]: {
          driver: ProviderDriverKind.make("devin"),
          displayName: "My Cloud",
          config: { cloud: true },
        },
      },
    };

    const cloud = cloudInstance(settings);

    expect(cloud.displayName).toBe("My Cloud");
  });
});
