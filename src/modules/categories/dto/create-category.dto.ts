import { IsHexColor, IsIn, IsString, Length, MaxLength } from 'class-validator';

export class CreateCategoryDto {
  @IsString()
  @Length(1, 50)
  name!: string;

  @IsString()
  @MaxLength(50)
  icon!: string;

  @IsHexColor()
  color!: string;

  @IsIn(['income', 'expense', 'both'])
  type!: 'income' | 'expense' | 'both';
}
