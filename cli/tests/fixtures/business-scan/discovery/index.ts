// Static Pulumi discovery must never evaluate this module.
import * as aws from '@pulumi/aws';
new aws.s3.Bucket('synthetic-bucket-value-never-export');
throw new Error('synthetic executable infrastructure must never run');
