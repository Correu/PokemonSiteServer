# Base image
FROM node:20

# Create app directory inside container
WORKDIR /usr/src/app

# Install app dependencies
COPY package*.json ./
RUN npm i

# Copy all source code into the container
COPY . .

# Expose the port your server listens on
EXPOSE 3000

# Start the server
CMD ["node", "index.js"]
