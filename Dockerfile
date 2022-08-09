FROM node:16

WORKDIR /usr/src/app

RUN apt-get -y update && apt-get -y install ffmpeg

COPY package*.json ./
RUN npm install
COPY . .
EXPOSE 3000
CMD [ "npm", "start" ]