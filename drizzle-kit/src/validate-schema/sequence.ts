import { Sequence } from './utils';

export class ValidateSequence {
  constructor(private errors: string[], private schema: string | undefined, private name: string) {}

  incorrectvalues(sequence: Sequence) {
    let { increment, maxValue, minValue } = sequence.seqOptions ?? {};
    increment ??= 1;
    const baseMessage = `Sequence ${this.schema ? `"${this.schema}".` : ''}"${this.name}" `;

    if (Number(increment) === 0) {
      this.errors.push(`${baseMessage}is set to increment by 0, which is an invalid value`);
    }

    if (minValue && maxValue && Number(minValue) > Number(maxValue)) {
      this.errors.push(`${baseMessage}has a minimum value greater than its max value`);
    }
  }
}
