import { Pipe, PipeTransform } from '@angular/core';
import { camelCase } from './logic';

/** `{{ value | camel }}` — CamelCase display text for Latin labels and enum values. */
@Pipe({ name: 'camel' })
export class CamelPipe implements PipeTransform {
  transform(value: string | null | undefined): string {
    return camelCase(value);
  }
}
