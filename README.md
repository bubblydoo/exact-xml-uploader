# Exact XML Uploader

This is a simple tool to upload XML files to Exact Online (uses the XML Import functionality). It is written in Typescript and uses Puppeteer.

## Usage

```bash
npx env-cmd -f .env -- npm run upload -- --dir ../folder-with-xmls --tmp-dir tmp --otp 123456 
```

You need to make 3 environment variables available:

```
USERNAME="Username"
PASSWORD="Password"
EXACT_DIVISION="123456" # you can find this in the url of Exact Online after logging in
```

After upload, you can find error logs and screenshots in the `tmp` folder.