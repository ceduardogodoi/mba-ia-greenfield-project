import type { ValidationError } from 'joi';
import { envValidationSchema } from './env.validation';

const requiredEnv = {
  DB_USERNAME: 'user',
  DB_PASSWORD: 'pass',
  DB_NAME: 'db',
  JWT_SECRET: 'secret',
  JWT_REFRESH_SECRET: 'refresh-secret',
  S3_ACCESS_KEY: 'access',
  S3_SECRET_KEY: 'secret',
};

interface EnvValidationResult {
  error?: ValidationError;
  value: Record<string, unknown>;
}

const validate = (env: Record<string, string>): EnvValidationResult => {
  const result = envValidationSchema.validate(
    { ...requiredEnv, ...env },
    { allowUnknown: true, abortEarly: false },
  );
  return {
    error: result.error,
    value: result.value as Record<string, unknown>,
  };
};

describe('envValidationSchema — SWAGGER_ENABLED', () => {
  it('should reject SWAGGER_ENABLED with an invalid value', () => {
    const { error } = validate({ SWAGGER_ENABLED: 'invalid' });
    expect(error).toBeDefined();
    expect(error!.message).toContain('SWAGGER_ENABLED');
  });

  it('should accept SWAGGER_ENABLED=true', () => {
    const { error } = validate({ SWAGGER_ENABLED: 'true' });
    expect(error).toBeUndefined();
  });

  it('should accept SWAGGER_ENABLED=false', () => {
    const { error } = validate({ SWAGGER_ENABLED: 'false' });
    expect(error).toBeUndefined();
  });

  it('should apply default false when SWAGGER_ENABLED is not set', () => {
    const { value, error } = validate({});
    expect(error).toBeUndefined();
    expect(value.SWAGGER_ENABLED).toBe('false');
  });
});

describe('envValidationSchema — storage and queue (phase 03)', () => {
  const withoutKey = (key: string): Record<string, string> => {
    const env: Record<string, string> = { ...requiredEnv };
    delete env[key];
    return env;
  };

  it.each(['S3_ACCESS_KEY', 'S3_SECRET_KEY'])(
    'should reject a missing %s',
    (key) => {
      const result = envValidationSchema.validate(withoutKey(key), {
        allowUnknown: true,
        abortEarly: false,
      });
      expect(result.error).toBeDefined();
      expect(result.error!.message).toContain(key);
    },
  );

  it('should apply Compose-service defaults for storage and queue', () => {
    const { value, error } = validate({});
    expect(error).toBeUndefined();
    expect(value).toMatchObject({
      REDIS_HOST: 'redis',
      REDIS_PORT: 6379,
      S3_ENDPOINT: 'http://minio:9000',
      S3_PUBLIC_ENDPOINT: 'http://localhost:9000',
      S3_REGION: 'us-east-1',
      S3_BUCKET: 'streamtube-videos',
    });
  });

  it('should reject a non-URI S3_ENDPOINT', () => {
    const { error } = validate({ S3_ENDPOINT: 'not a uri' });
    expect(error).toBeDefined();
    expect(error!.message).toContain('S3_ENDPOINT');
  });
});
