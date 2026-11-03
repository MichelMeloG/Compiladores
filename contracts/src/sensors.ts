import { z } from 'zod';
import { LineReadingSchema } from './device.js';

/** O ESP lê pinos e informa a última saída aplicada; todas as decisões são do backend. */
export const SensorInputSchema = z.object({
  line: LineReadingSchema,
  boot: z.string().regex(/^[A-Za-z0-9-]{1,64}$/),
  sequence: z.number().int().positive(),
  applied: z.number().int().nonnegative(),
}).strict();
export type SensorInput = z.infer<typeof SensorInputSchema>;

export const MotorOutputSchema = z.object({
  sequence: z.number().int().positive(),
  left: z.number().int().min(-255).max(255),
  right: z.number().int().min(-255).max(255),
});
export type MotorOutput = z.infer<typeof MotorOutputSchema>;
