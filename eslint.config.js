// @ts-check
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';

export default tseslint.config(
	{
		ignores: ['dist/**', 'node_modules/**', 'sample_actor_ts/**', 'sample_actor_py/**', 'data/**'],
	},
	js.configs.recommended,
	...tseslint.configs.recommended,
	prettier,
	{
		languageOptions: {
			parserOptions: {
				sourceType: 'module',
			},
		},
		rules: {
			'@typescript-eslint/no-explicit-any': 'error',
			'@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
			'no-restricted-syntax': [
				'error',
				{
					selector: "CallExpression[callee.property.name='purgeDefaultStorages']",
					message: 'Never call purgeDefaultStorages() outside the storage bootstrap module.',
				},
				{
					selector: "CallExpression[callee.property.name='purge'][callee.object.property.name!='backend']",
					message: 'Never call *.purge() outside the storage bootstrap module.',
				},
			],
		},
	},
);
