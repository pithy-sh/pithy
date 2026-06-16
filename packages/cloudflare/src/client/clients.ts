import { CloudflareAIManager } from "../ai/aiManager";
import { CloudflareVectorizeManager } from "../ai/vectorizeManager";
import { CloudflareD1Manager } from "../d1/d1Manager";
import { CloudflareD1Provisioner } from "../d1/d1Provisioner";
import { CloudflareCustomHostnamesManager } from "../hostnames/customHostnamesManager";
import { CloudflareKVManager } from "../kv/kvManager";
import { CloudflareImageManager } from "../media/imageManager";
import { CloudflareStreamManager } from "../media/streamManager";
import { CloudflareQueueManager } from "../queue/queueManager";
import type { R2Credentials } from "../r2/r2Credentials";
import { CloudflareR2Manager } from "../r2/r2Manager";
import { CloudflareSecretsStoreManager } from "../secrets/secretsStoreManager";
import { CloudflareTurnstileManager } from "../turnstile/turnstileManager";
import { CloudflareBuildsManager } from "../workers/buildsManager";
import { CloudflareWorkersManager } from "../workers/workersManager";
import { WorkersProvisioner } from "../workers/workersProvisioner";
import type { CloudflareManagerConfig } from "./manager";

/**
 * One configured entry point to every Cloudflare REST manager. This is a runtime aggregator — it
 * constructs and memoizes managers from a single `{ apiToken, accountId }` config — **not** a
 * re-export barrel (CLAUDE.md forbids those); the composition logic is the reason it exists.
 *
 * Resource-scoped managers (KV, D1, queues, Vectorize indexes, secret stores, hostname zones, R2
 * buckets) are keyed by their resource id, so repeated calls for the same id return one shared
 * instance. Account-scoped managers (AI, Images, Stream, Workers, Builds, Turnstile) are singletons.
 */
export class CloudflareClients {
  private readonly config: CloudflareManagerConfig;

  private readonly kvByNamespace = new Map<string, CloudflareKVManager>();

  private readonly d1ByDatabase = new Map<string, CloudflareD1Manager>();

  private readonly queueByName = new Map<string, CloudflareQueueManager>();

  private readonly vectorizeByIndex = new Map<string, CloudflareVectorizeManager>();

  private readonly secretsByStore = new Map<string, CloudflareSecretsStoreManager>();

  private readonly hostnamesByZone = new Map<string, CloudflareCustomHostnamesManager>();

  private aiManager?: CloudflareAIManager;

  private imageManager?: CloudflareImageManager;

  private streamManager?: CloudflareStreamManager;

  private workersManager?: CloudflareWorkersManager;

  private buildsManager?: CloudflareBuildsManager;

  private turnstileManager?: CloudflareTurnstileManager;

  private workersProvisioner?: WorkersProvisioner;

  private d1ProvisionerManager?: CloudflareD1Provisioner;

  constructor(config: CloudflareManagerConfig) {
    this.config = config;
  }

  /** The KV manager for a namespace id. */
  kv(namespaceId: string): CloudflareKVManager {
    return memo(this.kvByNamespace, namespaceId, () => new CloudflareKVManager({ ...this.config, namespaceId }));
  }

  /** The D1 manager for a database id (also a Kysely `D1Dialect` database). */
  d1(databaseId: string): CloudflareD1Manager {
    return memo(this.d1ByDatabase, databaseId, () => new CloudflareD1Manager({ ...this.config, databaseId }));
  }

  /** The Queue manager for a queue name. */
  queue(queueName: string): CloudflareQueueManager {
    return memo(this.queueByName, queueName, () => new CloudflareQueueManager({ ...this.config, queueName }));
  }

  /** The Vectorize manager for an index name. */
  vectorize(indexName: string): CloudflareVectorizeManager {
    return memo(this.vectorizeByIndex, indexName, () => new CloudflareVectorizeManager({ ...this.config, indexName }));
  }

  /** The Secrets Store manager for a store id. */
  secrets(storeId: string): CloudflareSecretsStoreManager {
    return memo(this.secretsByStore, storeId, () => new CloudflareSecretsStoreManager({ ...this.config, storeId }));
  }

  /** The Custom Hostnames manager for a zone id. */
  hostnames(zoneId: string): CloudflareCustomHostnamesManager {
    return memo(this.hostnamesByZone, zoneId, () => new CloudflareCustomHostnamesManager({ ...this.config, zoneId }));
  }

  /**
   * The R2 manager for a bucket. R2 needs S3 credentials beyond the API token, so they are supplied
   * here per call — the manager is **not** memoized: caching by bucket name alone would hand back a
   * stale instance after a credential rotation. Construction is cheap (the S3 client is lazy).
   */
  r2(bucket: R2Credentials & { bucketName: string }): CloudflareR2Manager {
    return new CloudflareR2Manager({ ...this.config, ...bucket });
  }

  /** The account-scoped Workers AI manager. */
  ai(): CloudflareAIManager {
    this.aiManager ??= new CloudflareAIManager(this.config);
    return this.aiManager;
  }

  /** The account-scoped Images manager. */
  images(): CloudflareImageManager {
    this.imageManager ??= new CloudflareImageManager(this.config);
    return this.imageManager;
  }

  /** The account-scoped Stream manager. */
  stream(): CloudflareStreamManager {
    this.streamManager ??= new CloudflareStreamManager(this.config);
    return this.streamManager;
  }

  /** The account-scoped Workers (scripts/deployments) manager. */
  workers(): CloudflareWorkersManager {
    this.workersManager ??= new CloudflareWorkersManager(this.config);
    return this.workersManager;
  }

  /** The account-scoped Workers Builds manager. */
  builds(): CloudflareBuildsManager {
    this.buildsManager ??= new CloudflareBuildsManager(this.config);
    return this.buildsManager;
  }

  /** The account-scoped Turnstile manager. */
  turnstile(): CloudflareTurnstileManager {
    this.turnstileManager ??= new CloudflareTurnstileManager(this.config);
    return this.turnstileManager;
  }

  /** The Workers provisioner (orchestrates the Workers + Builds managers). */
  provisioner(): WorkersProvisioner {
    this.workersProvisioner ??= new WorkersProvisioner(this.config);
    return this.workersProvisioner;
  }

  /** The account-scoped D1 control plane — create and delete databases. */
  d1Provisioner(): CloudflareD1Provisioner {
    this.d1ProvisionerManager ??= new CloudflareD1Provisioner(this.config);
    return this.d1ProvisionerManager;
  }
}

/** Return the cached value for `key`, constructing and storing it on first access. */
function memo<T>(cache: Map<string, T>, key: string, make: () => T): T {
  const existing = cache.get(key);
  if (existing !== undefined) return existing;
  const created = make();
  cache.set(key, created);
  return created;
}
